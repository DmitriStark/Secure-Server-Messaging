const fs = require("fs");
const path = require("path");
const cryptoUtils = require("../src/utils/cryptography");

// Mock logger to avoid console output during tests
jest.mock("../src/utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

describe("Cryptography Utilities", () => {
  let keyPair;
  let secureKey;
  const testData =
    "This is a test message that needs to be encrypted and decrypted";

  beforeAll(() => {
    // Ensure the keys directory exists for tests
    const keysDir = path.join(__dirname, "../keys");
    if (!fs.existsSync(keysDir)) {
      fs.mkdirSync(keysDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test keys
    const privateKeyPath = path.join(__dirname, "../keys/server-private.pem");
    const publicKeyPath = path.join(__dirname, "../keys/server-public.pem");

    if (fs.existsSync(privateKeyPath)) {
      fs.unlinkSync(privateKeyPath);
    }

    if (fs.existsSync(publicKeyPath)) {
      fs.unlinkSync(publicKeyPath);
    }
  });

  describe("setupServerKeys()", () => {
    it("should generate server keys if they do not exist", () => {
      // Run the setup function
      cryptoUtils.setupServerKeys();

      // Check if keys were created
      const privateKeyPath = path.join(__dirname, "../keys/server-private.pem");
      const publicKeyPath = path.join(__dirname, "../keys/server-public.pem");

      expect(fs.existsSync(privateKeyPath)).toBe(true);
      expect(fs.existsSync(publicKeyPath)).toBe(true);

      // Read the keys to ensure they are in the right format
      const privateKey = fs.readFileSync(privateKeyPath, "utf8");
      const publicKey = fs.readFileSync(publicKeyPath, "utf8");

      expect(privateKey).toContain("BEGIN PRIVATE KEY");
      expect(privateKey).toContain("END PRIVATE KEY");
      expect(publicKey).toContain("BEGIN PUBLIC KEY");
      expect(publicKey).toContain("END PUBLIC KEY");
    });
  });

  describe("generateKeyPair()", () => {
    it("should generate a valid RSA key pair", () => {
      keyPair = cryptoUtils.generateKeyPair();

      expect(keyPair).toHaveProperty("privateKey");
      expect(keyPair).toHaveProperty("publicKey");
      expect(keyPair.privateKey).toContain("BEGIN PRIVATE KEY");
      expect(keyPair.privateKey).toContain("END PRIVATE KEY");
      expect(keyPair.publicKey).toContain("BEGIN PUBLIC KEY");
      expect(keyPair.publicKey).toContain("END PUBLIC KEY");
    });
  });

  describe("RSA Encryption and Decryption", () => {
    it("should encrypt data with a public key and decrypt it with the corresponding private key", () => {
      // Encrypt with public key
      const encryptedData = cryptoUtils.encryptWithPublicKey(
        keyPair.publicKey,
        testData
      );

      expect(typeof encryptedData).toBe("string");
      expect(encryptedData).not.toBe(testData);

      // Decrypt with private key
      const decryptedData = cryptoUtils.decryptWithPrivateKey(
        keyPair.privateKey,
        encryptedData
      );

      expect(decryptedData).toBe(testData);
    });

    it("should throw an error when trying to decrypt with the wrong private key", () => {
      // Generate a different key pair
      const anotherKeyPair = cryptoUtils.generateKeyPair();

      // Encrypt with first public key
      const encryptedData = cryptoUtils.encryptWithPublicKey(
        keyPair.publicKey,
        testData
      );

      // Try to decrypt with the wrong private key
      expect(() => {
        cryptoUtils.decryptWithPrivateKey(
          anotherKeyPair.privateKey,
          encryptedData
        );
      }).toThrow();
    });
  });

  describe("AES Encryption and Decryption", () => {
    it("should generate a secure symmetric key", () => {
      secureKey = cryptoUtils.generateSecureKey();

      expect(typeof secureKey).toBe("string");
      expect(secureKey.length).toBe(64); // 32 bytes in hex = 64 characters
    });

    it("should encrypt and decrypt messages with AES", () => {
      // Encrypt message
      const { encryptedData, iv, authTag } = cryptoUtils.encryptMessage(
        testData,
        secureKey
      );

      expect(typeof encryptedData).toBe("string");
      expect(typeof iv).toBe("string");
      expect(typeof authTag).toBe("string");
      expect(encryptedData).not.toBe(testData);

      // Decrypt message
      const decryptedData = cryptoUtils.decryptMessage(
        encryptedData,
        iv,
        authTag,
        secureKey
      );

      expect(decryptedData).toBe(testData);
    });

    it("should fail to decrypt with the wrong key", () => {
      // Encrypt message
      const { encryptedData, iv, authTag } = cryptoUtils.encryptMessage(
        testData,
        secureKey
      );

      // Generate a different key
      const wrongKey = cryptoUtils.generateSecureKey();

      // Try to decrypt with wrong key
      expect(() => {
        cryptoUtils.decryptMessage(encryptedData, iv, authTag, wrongKey);
      }).toThrow();
    });

    it("should fail to decrypt with the wrong authentication tag", () => {
      // Encrypt message
      const { encryptedData, iv } = cryptoUtils.encryptMessage(
        testData,
        secureKey
      );

      // Create wrong auth tag
      const wrongAuthTag = "wrongauthtagdata".padEnd(32, "0");

      // Try to decrypt with wrong auth tag
      expect(() => {
        cryptoUtils.decryptMessage(encryptedData, iv, wrongAuthTag, secureKey);
      }).toThrow();
    });
  });

  describe("hashData()", () => {
    it("should create consistent hashes for the same input", () => {
      const hash1 = cryptoUtils.hashData(testData);
      const hash2 = cryptoUtils.hashData(testData);

      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe("string");
      expect(hash1.length).toBe(64); // SHA-256 produces 32 bytes = 64 hex chars
    });

    it("should create different hashes for different inputs", () => {
      const hash1 = cryptoUtils.hashData(testData);
      const hash2 = cryptoUtils.hashData(testData + "modified");

      expect(hash1).not.toBe(hash2);
    });
  });
});
