const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const userManagementController = require("../controllers/UserManagementController");

router.get("/public-keys", authenticate, (req, res) => 
  userManagementController.getAllPublicKeys(req, res));

router.post("/update-key", authenticate, (req, res) => 
  userManagementController.updatePublicKey(req, res));

module.exports = router;