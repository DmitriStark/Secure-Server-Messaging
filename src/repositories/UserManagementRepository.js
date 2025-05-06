const User = require("../models/User");

class UserManagementRepository {
  async getAllUsersPublicKeys() {
    return User.find({}, "username publicKey");
  }

  async updateUserPublicKey(username, publicKey) {
    return User.findOneAndUpdate({ username }, { publicKey });
  }
}

module.exports = new UserManagementRepository();