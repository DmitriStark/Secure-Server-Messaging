const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const keyController = require("../controllers/KeyController");

router.get("/server-public", (req, res) => keyController.getServerPublicKey(req, res));
router.get("/user/:username", (req, res) => keyController.getUserPublicKey(req, res));
router.get("/users", authenticate, (req, res) => keyController.getAllUsersPublicKeys(req, res));

module.exports = router;