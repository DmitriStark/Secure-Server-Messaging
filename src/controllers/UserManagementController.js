const logger = require("../utils/logger");
const userManagementRepository = require("../repositories/UserManagementRepository");

class UserManagementController {
  async getAllPublicKeys(req, res) {
    try {
      const users = await userManagementRepository.getAllUsersPublicKeys();
      
      return res.status(200).json({
        users,
      });
    } catch (error) {
      logger.error("Error fetching public keys:", error);
      return res.status(500).json({ message: "Failed to fetch public keys" });
    }
  }

  async updatePublicKey(req, res) {
    try {
      const { publicKey } = req.body;
      
      if (!publicKey) {
        return res.status(400).json({ message: "Public key is required" });
      }
      
      // Update user's public key
      await userManagementRepository.updateUserPublicKey(req.user.username, publicKey);
      
      logger.info(`Public key updated for user: ${req.user.username}`);
      
      return res.status(200).json({
        message: "Public key updated successfully",
      });
    } catch (error) {
      logger.error("Error updating public key:", error);
      return res.status(500).json({ message: "Failed to update public key" });
    }
  }
}

module.exports = new UserManagementController();