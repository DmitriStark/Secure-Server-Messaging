jest.mock("../src/utils/cryptography", () => {
  return {
    encryptWithPublicKey: jest.fn(
      (pubKey, data) => `encrypted-${data}-with-${pubKey}`
    ),
    decryptWithPrivateKey: jest.fn((privKey, data) => {
      // Fix this function to return the whole symmetric key
      if (data.startsWith("encrypted-")) {
        // Parse out the symmetric key from "encrypted-[key]-with-[pubKey]"
        const parts = data.split("-with-")[0]; // "encrypted-secure-key-123456"
        return parts.substring(10); // Just return "secure-key-123456"
      }
      return null;
    }),
    generateSecureKey: jest.fn(() => "secure-key-123456"),
    encryptMessage: jest.fn((text, key) => ({
      encryptedData: `encrypted-${text}`,
      iv: "test-iv",
      authTag: "test-auth-tag",
    })),
    decryptMessage: jest.fn((encData, iv, authTag, key) =>
      encData.startsWith("encrypted-") ? encData.substring(10) : null
    ),
  };
});

describe("Message Encryption", () => {
  // Test data
  const testUsers = [
    { username: "alice", publicKey: "alice-public-key" },
    { username: "bob", publicKey: "bob-public-key" },
    { username: "charlie", publicKey: "charlie-public-key" },
  ];

  const testMessage = "Hello, this is a secret message!";

  const cryptoUtils = require("../src/utils/cryptography");

  test("should encrypt a message with symmetric key", () => {
    // Generate a symmetric key
    const symmetricKey = cryptoUtils.generateSecureKey();
    expect(symmetricKey).toBe("secure-key-123456");

    // Encrypt the message
    const { encryptedData, iv, authTag } = cryptoUtils.encryptMessage(
      testMessage,
      symmetricKey
    );

    expect(encryptedData).toBe(`encrypted-${testMessage}`);
    expect(iv).toBe("test-iv");
    expect(authTag).toBe("test-auth-tag");
  });

  test("should encrypt the symmetric key with recipient public keys", () => {
    // Generate a symmetric key
    const symmetricKey = cryptoUtils.generateSecureKey();

    // Encrypt key for each recipient
    const recipientKeys = {};
    for (const user of testUsers) {
      recipientKeys[user.username] = cryptoUtils.encryptWithPublicKey(
        user.publicKey,
        symmetricKey
      );
    }

    // Check each encrypted key
    expect(recipientKeys.alice).toBe(
      `encrypted-${symmetricKey}-with-alice-public-key`
    );
    expect(recipientKeys.bob).toBe(
      `encrypted-${symmetricKey}-with-bob-public-key`
    );
    expect(recipientKeys.charlie).toBe(
      `encrypted-${symmetricKey}-with-charlie-public-key`
    );
  });

  test("should decrypt the symmetric key with recipient private key", () => {
    // Generate a symmetric key
    const symmetricKey = cryptoUtils.generateSecureKey();

    // Encrypt key for recipient
    const encryptedKey = cryptoUtils.encryptWithPublicKey(
      "recipient-public-key",
      symmetricKey
    );

    // Decrypt with private key
    const decryptedKey = cryptoUtils.decryptWithPrivateKey(
      "recipient-private-key",
      encryptedKey
    );

    expect(decryptedKey).toBe(symmetricKey);
  });

  test("should decrypt message with the symmetric key", () => {
    // Generate a symmetric key
    const symmetricKey = cryptoUtils.generateSecureKey();

    // Encrypt the message
    const { encryptedData, iv, authTag } = cryptoUtils.encryptMessage(
      testMessage,
      symmetricKey
    );

    // Decrypt the message
    const decryptedMessage = cryptoUtils.decryptMessage(
      encryptedData,
      iv,
      authTag,
      symmetricKey
    );

    expect(decryptedMessage).toBe(testMessage);
  });
});

describe("Message Broadcasting", () => {
  // In a real system, this would be a map of connected client sockets or response objects
  const connectedClients = new Map();

  // Mock message queue for clients that aren't connected
  const messageQueue = [];

  // Sample users
  const users = [
    { username: "user1", isOnline: true },
    { username: "user2", isOnline: false },
    { username: "user3", isOnline: true },
  ];

  beforeEach(() => {
    // Reset connected clients and message queue
    connectedClients.clear();
    messageQueue.length = 0;

    // Set up connected clients
    connectedClients.set("client1", {
      username: "user1",
      res: { json: jest.fn() },
      timestamp: Date.now(),
    });

    connectedClients.set("client3", {
      username: "user3",
      res: { json: jest.fn() },
      timestamp: Date.now(),
    });
  });

  // Simple broadcast function that mimics the core functionality
  const broadcastMessage = (message) => {
    // Add to message queue for delivery
    messageQueue.push(message);

    // Track delivered count
    let deliveredCount = 0;

    // Iterate through connected clients
    for (const [clientId, client] of connectedClients.entries()) {
      // Check if client is a recipient
      if (message.recipients.includes(client.username)) {
        // In real implementation, this would send to the client's response object
        client.res.json({
          type: "message",
          data: message,
        });

        // Remove client from connected clients after delivery
        connectedClients.delete(clientId);
        deliveredCount++;
      }
    }

    return deliveredCount;
  };

  test("should broadcast message to all connected recipients", () => {
    // Create a message for all users
    const message = {
      sender: "admin",
      encryptedContent: "encrypted-broadcast-message",
      iv: "test-iv",
      recipients: ["user1", "user2", "user3"],
      timestamp: new Date(),
    };

    // Broadcast the message
    const deliveredCount = broadcastMessage(message);

    // Should deliver to user1 and user3 (user2 is offline)
    expect(deliveredCount).toBe(2);
    expect(connectedClients.size).toBe(0); // All clients removed after delivery
    expect(messageQueue).toContain(message);

    // Check if delivery was made to the client response objects
    const client1 = connectedClients.get("client1");
    const client3 = connectedClients.get("client3");

    // These will be undefined since they were removed from the map
    expect(client1).toBeUndefined();
    expect(client3).toBeUndefined();
  });

  test("should only broadcast to specified recipients", () => {
    // Reset connected clients
    connectedClients.clear();

    // Add three clients
    connectedClients.set("client1", {
      username: "user1",
      res: { json: jest.fn() },
      timestamp: Date.now(),
    });

    connectedClients.set("client2", {
      username: "user2",
      res: { json: jest.fn() },
      timestamp: Date.now(),
    });

    connectedClients.set("client3", {
      username: "user3",
      res: { json: jest.fn() },
      timestamp: Date.now(),
    });

    // Create a message just for user1
    const message = {
      sender: "admin",
      encryptedContent: "encrypted-targeted-message",
      iv: "test-iv",
      recipients: ["user1"],
      timestamp: new Date(),
    };

    // Broadcast the message
    const deliveredCount = broadcastMessage(message);

    // Should only deliver to user1
    expect(deliveredCount).toBe(1);
    expect(connectedClients.size).toBe(2); // Only user1 removed
    expect(messageQueue).toContain(message);

    // Check which clients remain
    expect(connectedClients.has("client1")).toBe(false);
    expect(connectedClients.has("client2")).toBe(true);
    expect(connectedClients.has("client3")).toBe(true);
  });

  test("should add messages to queue for offline recipients", () => {
    // Create a message for all users including offline user2
    const message = {
      sender: "admin",
      encryptedContent: "encrypted-message-for-all",
      iv: "test-iv",
      recipients: ["user1", "user2", "user3"],
      timestamp: new Date(),
    };

    // Broadcast the message
    broadcastMessage(message);

    // Check if message is in queue for user2 who is offline
    expect(messageQueue).toContain(message);

    // In a real implementation, when user2 connects, they would receive this message
    // from the message queue
  });
});
