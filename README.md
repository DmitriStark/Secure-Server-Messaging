# Secure Messaging Server

A high-performance, end-to-end encrypted messaging server built with Node.js, Express, and MongoDB.

## Features

- **End-to-End Encryption**: Messages are encrypted client-side, ensuring server never has access to plaintext content.
- **High Performance Architecture**: Utilizes Node.js clustering for multi-core processing.
- **Secure Authentication**: JWT-based authentication with Argon2id password hashing.
- **Real-time Communication**: Long-polling implementation for immediate message delivery.
- **Public Key Infrastructure**: RSA key pairs for secure key exchange.
- **Horizontal Scaling**: Designed for deployment across multiple nodes.

## Prerequisites

- Node.js (v14+)
- MongoDB (v4.4+)
- NPM or Yarn

## Installation

1. Clone the repository
```bash
git clone https://github.com/DmitriStark/Secure-Server-Messaging
cd secure-messaging/server
```

2. Install dependencies
```bash
npm install
```

3. Create environment variables file (.env)

better use env.example
```
PORT=3001
MONGODB_URI=mongodb://localhost:27017/secure-chat    !!! i used atlas mongodb+srv://username:password@cluster0.ramkbs5.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0

JWT_SECRET=your-secret-key-should-be-long-and-random
JWT_EXPIRATION=24h
NODE_ENV=development
```

4. Run the server
```bash
npm run start
```

## API Endpoints

### Authentication

- `POST /api/auth/register`: Register a new user
  - Body: `{ username, password, publicKey }`
  - Returns: User info and token

- `POST /api/auth/login`: Login existing user
  - Body: `{ username, password }`
  - Returns: User info and token

- `GET /api/auth/profile`: Get user profile (authenticated)
  - Returns: User profile

- `POST /api/auth/verify`: Verify JWT token
  - Body: `{ token }`
  - Returns: Validity status

- `POST /api/auth/logout`: Logout (blacklists token)

### Messages

- `GET /api/messages/all-messages`: Get all messages for the authenticated user
  - Returns: All encrypted messages available to the user

- `GET /api/messages/poll`: Long-polling endpoint for receiving messages
  - Returns: New messages as they arrive

- `POST /api/messages/send`: Send a new message
  - Body: `{ encryptedContent, iv, recipientKeys }`
  - Returns: Message ID

- `GET /api/messages/history`: Get message history
  - Query params: `page`, `limit`
  - Returns: Paginated message history

- `POST /api/messages/:messageId/read`: Mark message as read
  - Returns: Success status

- `GET /api/messages/:messageId`: Get a specific message
  - Returns: Message details

- `GET /api/messages/status`: Get system status
  - Returns: Performance metrics

### Key Management

- `GET /api/keys/server-public`: Get server's public key
  - Returns: Server public key

- `GET /api/keys/user/:username`: Get user's public key
  - Returns: User's public key

- `GET /api/keys/users`: Get all users' public keys (authenticated)
  - Returns: List of all users and their public keys

## Architecture

### Server Design

- **Master/Worker Architecture**: Uses Node.js cluster module to spawn workers across CPU cores
- **Connection Management**: Intelligent distribution of incoming connections
- **Memory Management**: Monitoring and garbage collection for sustained performance
- **Database Pooling**: Optimized connection pool for MongoDB
- **Token Blacklisting**: Protection against replay attacks

### Security Features

- **Password Security**: Argon2id with high memory cost for password hashing
- **Message Privacy**: Server stores only encrypted messages
- **Key Security**: Public-key cryptography for secure key exchange
- **Token Management**: JWT tokens with proper expiration and blacklisting

## Production Deployment

For production deployment, consider:

1. Setting up a reverse proxy (Nginx/Apache)
2. Configuring proper SSL/TLS
3. Connecting to a production MongoDB database
4. Setting appropriate system limits (ulimit)
5. Using a process manager like PM2

Example PM2 configuration:
```json
{
  "apps": [{
    "name": "secure-chat",
    "script": "index.js",
    "instances": "max",
    "exec_mode": "cluster",
    "env": {
      "NODE_ENV": "production",
      "PORT": 3001
    }
  }]
}
```

## Performance Considerations

The server includes several optimizations:

- Connection pooling for MongoDB
- Memory usage monitoring
- Worker process load balancing
- Message batching for database operations
- Efficient socket handling

## License

[MIT License](LICENSE)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.