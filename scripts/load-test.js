// Load testing script for 10,000 concurrent connections
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Configuration - UPDATED PORT TO 3001
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001/api';
const TOTAL_CLIENTS = parseInt(process.env.CLIENTS || '100'); // Start with a smaller number first
const RAMP_UP_TIME = parseInt(process.env.RAMP_UP || '60000'); // 1 minute
const TEST_DURATION = parseInt(process.env.DURATION || '180000'); // 3 minutes
const WAIT_BETWEEN_REQUESTS = parseInt(process.env.WAIT || '500'); // ms between poll requests
const LOG_FILE = path.join(__dirname, 'load-test-results.json');

// Metrics
const metrics = {
  startTime: Date.now(),
  endTime: 0,
  totalConnections: 0,
  maxConcurrentConnections: 0,
  successfulPolls: 0,
  failedPolls: 0,
  successfulMessages: 0,
  failedMessages: 0,
  totalLatency: 0,
  maxLatency: 0,
  serverErrors: 0,
  clientErrors: 0,
  timeouts: 0,
  activeClients: new Map()
};

// Generate test users
const TOTAL_TEST_USERS = Math.min(10, Math.ceil(TOTAL_CLIENTS / 100));
const testUsers = [];
let availableUsers = [];

// Generate RSA keys
const generateKeyPair = () => {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair('rsa', {
      modulusLength: 2048, // Smaller for testing
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    }, (err, publicKey, privateKey) => {
      if (err) {
        reject(err);
      } else {
        resolve({ publicKey, privateKey });
      }
    });
  });
};

// Register a test user
const registerUser = async (index) => {
  try {
    const username = `loadtest_user_${index}_${uuidv4().substring(0, 8)}`;
    const password = "Password123!"; // Valid password that meets requirements
    
    console.log(`Attempting to register ${username}`);
    
    // Generate keys
    const { publicKey, privateKey } = await generateKeyPair();
    
    // Register the user - matching the exact User model fields
    const response = await axios.post(`${BASE_URL}/auth/register`, {
      username,
      password,
      publicKey
    });
    
    const user = {
      username,
      password,
      publicKey,
      privateKey,
      token: response.data.token
    };
    
    testUsers.push(user);
    availableUsers.push(user);
    
    console.log(`Registered test user: ${username}`);
    return user;
  } catch (error) {
    console.error(`Error registering test user ${index}:`, error.response?.data?.message || error.message);
    
    // Wait a bit before retrying to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Try again with a different username
    return registerUser(index + 100);
  }
};

// Create test users
const createTestUsers = async () => {
  console.log(`Creating ${TOTAL_TEST_USERS} test users...`);
  const promises = [];
  
  for (let i = 0; i < TOTAL_TEST_USERS; i++) {
    // Create users sequentially to avoid overwhelming the server
    try {
      const user = await registerUser(i);
      promises.push(user);
      // Small delay between user registrations
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.error(`Failed to create user ${i}:`, err.message);
    }
  }
  
  // Wait for all registrations to complete
  await Promise.all(promises);
  console.log(`Created ${testUsers.length} test users`);
};

// Send a test message
const sendMessage = async (api, user, clientId) => {
  // Generate a random message
  const plaintext = `Test message ${Date.now()} from ${user.username}`;
  
  // Simple encryption for testing (in a real app, would encrypt with recipient's public key)
  const encryptMessage = (text) => {
    const iv = crypto.randomBytes(16);
    const key = crypto.randomBytes(32);
    
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return {
      iv: iv.toString('hex'),
      encryptedContent: encrypted,
      key: key.toString('hex')
    };
  };
  
  const { iv, encryptedContent, key } = encryptMessage(plaintext);
  
  // Create recipient keys (simplified for testing)
  const recipientKeys = {};
  for (const testUser of testUsers) {
    try {
      // In a real app, we would encrypt the AES key with each recipient's public key
      // For testing, we'll just use a placeholder
      recipientKeys[testUser.username] = Buffer.from(key).toString('base64');
    } catch (err) {
      console.error('Error creating recipient key:', err.message);
    }
  }
  
  // Send the message
  await api.post('/messages/send', {
    encryptedContent,
    iv,
    recipientKeys
  });
  
  const clientInfo = metrics.activeClients.get(clientId);
  if (clientInfo) {
    clientInfo.messageCount++;
    metrics.activeClients.set(clientId, clientInfo);
  }
};

// Simulate a client
const simulateClient = async (clientId) => {
  // Select a random user from available users
  if (availableUsers.length === 0) {
    availableUsers = [...testUsers];
  }
  
  const userIndex = Math.floor(Math.random() * availableUsers.length);
  const user = availableUsers[userIndex];
  availableUsers.splice(userIndex, 1);
  
  // Track active client
  metrics.activeClients.set(clientId, {
    startTime: Date.now(),
    user: user.username,
    pollCount: 0,
    messageCount: 0
  });
  
  // Update metrics
  metrics.totalConnections++;
  metrics.maxConcurrentConnections = Math.max(
    metrics.maxConcurrentConnections, 
    metrics.activeClients.size
  );

  // Set axios defaults
  const api = axios.create({
    baseURL: BASE_URL,
    timeout: 35000,
    headers: {
      'Authorization': `Bearer ${user.token}`,
      'Content-Type': 'application/json'
    }
  });
  
  // Long polling loop
  const pollForMessages = async () => {
    try {
      const startTime = Date.now();
      
      const response = await api.get('/messages/poll');
      
      const latency = Date.now() - startTime;
      metrics.totalLatency += latency;
      metrics.maxLatency = Math.max(metrics.maxLatency, latency);
      
      // Handle response
      if (response.data.type === 'message') {
        metrics.successfulPolls++;
        
        // Send a message occasionally (1 in 20 chance)
        if (Math.random() < 0.05) {
          try {
            await sendMessage(api, user, clientId);
            metrics.successfulMessages++;
          } catch (err) {
            metrics.failedMessages++;
          }
        }
      } else if (response.data.type === 'timeout') {
        metrics.timeouts++;
      }
      
      // Update client metrics
      const clientInfo = metrics.activeClients.get(clientId);
      if (clientInfo) {
        clientInfo.pollCount++;
        metrics.activeClients.set(clientId, clientInfo);
      }
      
      // Continue polling if test is still running
      if (Date.now() < metrics.startTime + TEST_DURATION) {
        // Add random delay to prevent thundering herd
        setTimeout(pollForMessages, Math.random() * WAIT_BETWEEN_REQUESTS);
      } else {
        // Test complete for this client
        metrics.activeClients.delete(clientId);
        // Make user available again
        availableUsers.push(user);
      }
    } catch (error) {
      // Handle errors
      if (error.response) {
        if (error.response.status >= 500) {
          metrics.serverErrors++;
        } else if (error.response.status >= 400) {
          metrics.clientErrors++;
        }
      } else if (error.code === 'ECONNABORTED') {
        metrics.timeouts++;
      }
      
      metrics.failedPolls++;
      
      // Continue polling if test is still running
      if (Date.now() < metrics.startTime + TEST_DURATION) {
        // Add longer delay on error to prevent overwhelming server
        setTimeout(pollForMessages, Math.random() * WAIT_BETWEEN_REQUESTS * 5);
      } else {
        // Test complete for this client
        metrics.activeClients.delete(clientId);
        // Make user available again
        availableUsers.push(user);
      }
    }
  };
  
  // Start polling
  pollForMessages();
};

// Log metrics periodically
const logMetrics = () => {
  const activeConnections = metrics.activeClients.size;
  const avgLatency = metrics.successfulPolls > 0 ? 
    Math.round(metrics.totalLatency / metrics.successfulPolls) : 0;
  
  console.log(`
=== Load Test Metrics ===
Time: ${Math.floor((Date.now() - metrics.startTime) / 1000)}s
Active Connections: ${activeConnections}
Max Concurrent: ${metrics.maxConcurrentConnections}
Successful Polls: ${metrics.successfulPolls}
Failed Polls: ${metrics.failedPolls}
Successful Messages: ${metrics.successfulMessages}
Failed Messages: ${metrics.failedMessages}
Average Latency: ${avgLatency}ms
Max Latency: ${metrics.maxLatency}ms
Server Errors: ${metrics.serverErrors}
Client Errors: ${metrics.clientErrors}
Timeouts: ${metrics.timeouts}
======================
  `);
  
  // Save metrics to file
  const metricsToSave = { ...metrics };
  delete metricsToSave.activeClients; // Don't save the Map
  metricsToSave.activeConnections = activeConnections;
  metricsToSave.avgLatency = avgLatency;
  metricsToSave.timestamp = new Date().toISOString();
  
  fs.writeFileSync(LOG_FILE, JSON.stringify(metricsToSave, null, 2));
  
  // Continue logging if test is still running
  if (Date.now() < metrics.startTime + TEST_DURATION) {
    setTimeout(logMetrics, 5000);
  } else if (activeConnections === 0) {
    // Test complete
    metrics.endTime = Date.now();
    console.log('Load test complete!');
    process.exit(0);
  } else {
    // Wait for remaining connections to close
    setTimeout(logMetrics, 5000);
  }
};

// Run the load test
const runLoadTest = async () => {
  console.log(`Starting load test with ${TOTAL_CLIENTS} clients over ${RAMP_UP_TIME/60000} minutes...`);
  
  // Create test users first
  await createTestUsers();
  
  // Start logging metrics
  setTimeout(logMetrics, 1000);
  
  // Start clients gradually
  const intervalTime = RAMP_UP_TIME / TOTAL_CLIENTS;
  
  for (let i = 0; i < TOTAL_CLIENTS; i++) {
    const startTime = Math.floor(i * intervalTime);
    setTimeout(() => {
      simulateClient(`client-${i}`);
      
      if (i % 100 === 0) {
        console.log(`Started ${i} clients...`);
      }
    }, startTime);
  }
};

// Handle errors and cleanup
process.on('SIGINT', () => {
  console.log('Test interrupted!');
  metrics.endTime = Date.now();
  
  // Save final metrics
  const metricsToSave = { ...metrics };
  delete metricsToSave.activeClients;
  metricsToSave.activeConnections = metrics.activeClients.size;
  metricsToSave.avgLatency = metrics.successfulPolls > 0 ? 
    Math.round(metrics.totalLatency / metrics.successfulPolls) : 0;
  metricsToSave.timestamp = new Date().toISOString();
  
  fs.writeFileSync(LOG_FILE, JSON.stringify(metricsToSave, null, 2));
  process.exit(0);
});

// Start the load test
runLoadTest().catch(err => {
  console.error('Error starting load test:', err);
  process.exit(1);
});