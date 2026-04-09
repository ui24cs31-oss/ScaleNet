# Use lightweight Node image
FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json .
RUN npm install

# Copy source
COPY server.js .

# Expose the worker port (overridden by env var at runtime)
EXPOSE 4001

# Start the server
CMD ["node", "server.js"]
