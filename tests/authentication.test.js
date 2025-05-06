jest.mock("argon2", () => ({
  hash: jest.fn().mockImplementation((password) => `hashed-${password}`),
  verify: jest.fn().mockImplementation((hashedPassword, password) => {
    return hashedPassword === `hashed-${password}`;
  }),
}));

// Mock JWT for token generation
jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockImplementation((payload, secret, options) => {
    return `mock-jwt-token-for-${payload.username}`;
  }),
  verify: jest.fn().mockImplementation((token, secret) => {
    if (token.startsWith("mock-jwt-token-for-")) {
      const username = token.substring("mock-jwt-token-for-".length);
      return { username };
    }
    throw new Error("Invalid token");
  }),
}));

const argon2 = require("argon2");
const jwt = require("jsonwebtoken");

describe("User Authentication", () => {
  // Test data
  const testUsers = {
    existingUser: {
      username: "existingUser",
      password: "hashed-securePassword123!",
      publicKey: "test-public-key",
    },
  };

  // Mock user model functions
  const mockUserModel = {
    findOne: jest.fn().mockImplementation((query) => {
      const username = query.username;
      return Promise.resolve(testUsers[username] || null);
    }),
    create: jest.fn().mockImplementation((userData) => {
      const newUser = { ...userData };
      testUsers[userData.username] = newUser;
      return Promise.resolve(newUser);
    }),
  };

  test("should register a new user with valid data", async () => {
    // User data
    const newUser = {
      username: "newTestUser",
      password: "securePassword123!",
      publicKey: "test-public-key",
    };

    // Check if user exists
    const existingUser = await mockUserModel.findOne({
      username: newUser.username,
    });
    expect(existingUser).toBeNull();

    // Hash password
    const hashedPassword = await argon2.hash(newUser.password);
    expect(hashedPassword).toBe(`hashed-${newUser.password}`);

    // Create user with hashed password
    const createdUser = await mockUserModel.create({
      ...newUser,
      password: hashedPassword,
    });

    expect(createdUser).toHaveProperty("username", newUser.username);
    expect(createdUser).toHaveProperty(
      "password",
      `hashed-${newUser.password}`
    );
    expect(createdUser).toHaveProperty("publicKey", newUser.publicKey);

    // Generate token
    const token = jwt.sign({ username: createdUser.username }, "secret-key", {
      expiresIn: "24h",
    });

    expect(token).toBe(`mock-jwt-token-for-${newUser.username}`);
  });

  test("should authenticate a user with correct credentials", async () => {
    // Login credentials
    const credentials = {
      username: "existingUser",
      password: "securePassword123!",
    };

    // Find user
    const user = await mockUserModel.findOne({
      username: credentials.username,
    });
    expect(user).not.toBeNull();

    // Verify password
    const isPasswordValid = await argon2.verify(
      user.password,
      credentials.password
    );
    expect(isPasswordValid).toBe(true);

    // Generate token
    const token = jwt.sign({ username: user.username }, "secret-key", {
      expiresIn: "24h",
    });

    expect(token).toBe(`mock-jwt-token-for-${credentials.username}`);
  });

  test("should reject authentication with incorrect password", async () => {
    // Login credentials with wrong password
    const credentials = {
      username: "existingUser",
      password: "wrongPassword",
    };

    // Find user
    const user = await mockUserModel.findOne({
      username: credentials.username,
    });
    expect(user).not.toBeNull();

    // Verify password
    const isPasswordValid = await argon2.verify(
      user.password,
      credentials.password
    );
    expect(isPasswordValid).toBe(false);
  });

  test("should reject authentication for non-existent user", async () => {
    // Login credentials for non-existent user
    const credentials = {
      username: "nonExistentUser",
      password: "anyPassword",
    };

    // Find user
    const user = await mockUserModel.findOne({
      username: credentials.username,
    });
    expect(user).toBeNull();
  });

  test("should verify valid token", () => {
    // Valid token
    const token = `mock-jwt-token-for-existingUser`;

    // Verify token
    const decoded = jwt.verify(token, "secret-key");

    expect(decoded).toHaveProperty("username", "existingUser");
  });

  test("should reject invalid token", () => {
    // Invalid token
    const token = "invalid-token";

    // Verify token should throw
    expect(() => {
      jwt.verify(token, "secret-key");
    }).toThrow();
  });

  test("should validate username format", () => {
    // Valid usernames
    expect(/^[a-zA-Z0-9_]{3,30}$/.test("validUser123")).toBe(true);
    expect(/^[a-zA-Z0-9_]{3,30}$/.test("valid_user")).toBe(true);

    // Invalid usernames
    expect(/^[a-zA-Z0-9_]{3,30}$/.test("ab")).toBe(false); // Too short
    expect(/^[a-zA-Z0-9_]{3,30}$/.test("invalid@user")).toBe(false); // Invalid character
    expect(/^[a-zA-Z0-9_]{3,30}$/.test("a".repeat(31))).toBe(false); // Too long
  });

  test("should validate password strength", () => {
    // Password regex: at least 8 characters, one uppercase, one lowercase, one digit, one special character
    const passwordRegex =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

    // Valid password
    expect(passwordRegex.test("SecureP@ss123")).toBe(true);

    // Invalid passwords
    expect(passwordRegex.test("weakpass")).toBe(false); // No uppercase, digit, or special char
    expect(passwordRegex.test("ALLCAPS123!")).toBe(false); // No lowercase
    expect(passwordRegex.test("NoDigits!")).toBe(false); // No digit
    expect(passwordRegex.test("NoSpecial123")).toBe(false); // No special char
    expect(passwordRegex.test("Short1!")).toBe(false); // Too short
  });
});
