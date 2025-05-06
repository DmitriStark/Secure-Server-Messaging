const keyRepository = require("../repositories/KeyRepository");
const logger = require("../utils/logger");

class KeyController {
  async getServerPublicKey(req, res) {
    try {
      const serverPublicKey = await keyRepository.getServerPublicKey();
      
      return res.status(200).json({
        publicKey: serverPublicKey,
      });
    } catch (error) {
      logger.error("Server public key retrieval error:", error);
      return res
        .status(500)
        .json({ message: "Failed to retrieve server public key" });
    }
  }

  async getUserPublicKey(req, res) {
    try {
      const { username } = req.params;
      
      const user = await keyRepository.getUserPublicKey(username);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      return res.status(200).json({
        username: user.username,
        publicKey: user.publicKey,
      });
    } catch (error) {
      logger.error("User public key retrieval error:", error);
      return res
        .status(500)
        .json({ message: "Failed to retrieve user public key" });
    }
  }

  async getAllUsersPublicKeys(req, res) {
    try {
      const users = await keyRepository.getAllUsersPublicKeys();
      
      return res.status(200).json({
        users: users.map((user) => ({
          username: user.username,
          publicKey: user.publicKey,
        })),
      });
    } catch (error) {
      logger.error("Users public keys retrieval error:", error);
      return res
        .status(500)
        .json({ message: "Failed to retrieve users public keys" });
    }
  }
}

module.exports = new KeyController();