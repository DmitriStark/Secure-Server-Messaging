const fs = require("fs");
const path = require("path");
const User = require("../models/User");

class KeyRepository {
  async getServerPublicKey() {
    const serverPublicKey = fs.readFileSync(
      path.join(__dirname, "../../keys/server-public.pem"),
      "utf8"
    );
    return serverPublicKey;
  }

  async getUserPublicKey(username) {
    const user = await User.findOne({ username }, "username publicKey");
    return user;
  }

  async getAllUsersPublicKeys() {
    const users = await User.find({}, "username publicKey");
    return users;
  }
}

module.exports = new KeyRepository();