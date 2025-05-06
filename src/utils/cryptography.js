const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const SERVER_PRIVATE_KEY_PATH = path.join(
  __dirname,
  "../../keys/server-private.pem"
);
const SERVER_PUBLIC_KEY_PATH = path.join(
  __dirname,
  "../../keys/server-public.pem"
);

const setupServerKeys = () => {
  try {
    if (!fs.existsSync(path.join(__dirname, "../../keys"))) {
      fs.mkdirSync(path.join(__dirname, "../../keys"), { recursive: true });
    }

    if (
      !fs.existsSync(SERVER_PRIVATE_KEY_PATH) ||
      !fs.existsSync(SERVER_PUBLIC_KEY_PATH)
    ) {
      logger.info("Generating server RSA key pair...");

      const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 4096,
        publicKeyEncoding: {
          type: "spki",
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem",
        },
      });

      fs.writeFileSync(SERVER_PRIVATE_KEY_PATH, privateKey);
      fs.writeFileSync(SERVER_PUBLIC_KEY_PATH, publicKey);

      logger.info("Server RSA key pair generated successfully");
    } else {
      logger.info("Server RSA key pair already exists");
    }
  } catch (error) {
    logger.error("Error setting up server keys:", error);
    process.exit(1);
  }
};

const encryptWithPublicKey = (publicKey, data) => {
  try {
    const encryptedData = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(data, "utf8")
    );

    return encryptedData.toString("base64");
  } catch (error) {
    logger.error("Error encrypting with public key:", error);
    throw new Error("Encryption failed");
  }
};

const decryptWithPrivateKey = (privateKey, encryptedData) => {
  try {
    const decryptedData = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encryptedData, "base64")
    );

    return decryptedData.toString("utf8");
  } catch (error) {
    logger.error("Error decrypting with private key:", error);
    throw new Error("Decryption failed");
  }
};

const encryptMessage = (text, key) => {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      iv
    );

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag().toString("hex");

    return {
      iv: iv.toString("hex"),
      encryptedData: encrypted,
      authTag,
    };
  } catch (error) {
    logger.error("Error encrypting message:", error);
    throw new Error("Message encryption failed");
  }
};

const decryptMessage = (encryptedData, iv, authTag, key) => {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      Buffer.from(iv, "hex")
    );

    decipher.setAuthTag(Buffer.from(authTag, "hex"));

    let decrypted = decipher.update(encryptedData, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    logger.error("Error decrypting message:", error);
    throw new Error("Message decryption failed");
  }
};

const generateSecureKey = () => {
  return crypto.randomBytes(32).toString("hex");
};

const generateKeyPair = () => {
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 4096,
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
      },
    });

    return { privateKey, publicKey };
  } catch (error) {
    logger.error("Error generating key pair:", error);
    throw new Error("Key pair generation failed");
  }
};

const hashData = (data) => {
  try {
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch (error) {
    logger.error("Error hashing data:", error);
    throw new Error("Hashing failed");
  }
};

module.exports = {
  setupServerKeys,
  encryptWithPublicKey,
  decryptWithPrivateKey,
  encryptMessage,
  decryptMessage,
  generateSecureKey,
  generateKeyPair,
  hashData,
};
