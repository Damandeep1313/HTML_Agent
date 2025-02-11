# Use Node.js as the base image
FROM node:18

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy the rest of the app files
COPY . .

# Expose port
EXPOSE 3000

# Command to start the app
CMD ["node", "f.js"]
