// Database seeding script
require('dotenv').config();
const mongoose = require('mongoose');
const argon2 = require('argon2');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const User = require('../src/models/User');
const Message = require('../src/models/Message');

// Setup basic logger for this script
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/secure-messaging';

// Load server public key
const SERVER_PUBLIC_KEY_PATH = path.join(__dirname, '../keys/server-public.pem');

// Generate a key pair
const generateKeyPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
  
  return { privateKey, publicKey };
};

// Encrypt a message with a user's public key
const encryptWithPublicKey = (publicKey, data) => {
  const encryptedData = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(data, 'utf8')
  );
  
  return encryptedData.toString('base64');
};

// Encrypt a message using AES for storage
const encryptMessageForStorage = (text) => {
  const iv = crypto.randomBytes(16);
  const key = crypto.randomBytes(32); // 256 bits for AES-256
  
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return {
    iv: iv.toString('hex'),
    encryptedContent: encrypted,
    key: key.toString('hex')
  };
};

// Generate mock users
const generateMockUsers = async (count) => {
  const users = [];
  
  for (let i = 1; i <= count; i++) {
    const username = `user${i}`;
    const password = `password${i}`;
    
    // Generate key pair for user
    const { privateKey, publicKey } = generateKeyPair();
    
    // Store the private key to a file for demo purposes
    // In a real app, the client would generate and store the private key
    fs.writeFileSync(
      path.join(__dirname, `../keys/${username}-private.pem`),
      privateKey
    );
    
    // Hash the password
    const hashedPassword = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16,
      timeCost: 3,
      parallelism: 1
    });
    
    users.push({
      username,
      password: hashedPassword,
      publicKey,
      createdAt: new Date(),
      lastLogin: null
    });
    
    logger.info(`Generated user: ${username}`);
  }
  
  return users;
};

// Generate mock messages
const generateMockMessages = async (users) => {
  const messages = [];
  const serverPublicKey = fs.readFileSync(SERVER_PUBLIC_KEY_PATH, 'utf8');
  
  for (let i = 1; i <= 50; i++) {
    // Select random sender and recipients
    const senderIndex = Math.floor(Math.random() * users.length);
    const sender = users[senderIndex].username;
    
    // All users are recipients in this demo
    const recipients = users.map(user => user.username);
    
    // Create a mock message
    const plaintext = `This is test message #${i} from ${sender}`;
    
    // Encrypt the message for storage (in a real app, this would be done by the client)
    const { iv, encryptedContent, key } = encryptMessageForStorage(plaintext);
    
    // In a real app, the client would encrypt the symmetric key with the server's public key
    const encryptedKey = encryptWithPublicKey(serverPublicKey, key);
    
    messages.push({
      sender,
      encryptedContent,
      iv,
      recipients,
      timestamp: new Date(Date.now() - Math.floor(Math.random() * 7 * 24 * 60 * 60 * 1000)) // Random time in the last week
    });
  }
  
  logger.info(`Generated ${messages.length} messages`);
  return messages;
};

// Seed the database
const seedDatabase = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    logger.info('Connected to MongoDB');
    
    // Clear existing data
    await User.deleteMany({});
    await Message.deleteMany({});
    
    logger.info('Cleared existing data');
    
    // Generate and save mock users
    const mockUsers = await generateMockUsers(5);
    await User.insertMany(mockUsers);
    
    logger.info('Saved mock users');
    
    // Generate and save mock messages
    const mockMessages = await generateMockMessages(mockUsers);
    await Message.insertMany(mockMessages);
    
    logger.info('Saved mock messages');
    
    logger.info('Database seeded successfully');
  } catch (error) {
    logger.error('Error seeding database:', error);
  } finally {
    // Disconnect from MongoDB
    await mongoose.disconnect();
    logger.info('Disconnected from MongoDB');
  }
};

// Run the seeding process
seedDatabase();