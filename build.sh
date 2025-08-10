#!/bin/bash

# Build für die aktuelle Plattform
echo "Building Docker image..."
docker build -t ollama-ui .

# Oder für Multi-Platform Build (falls gewünscht)
# docker buildx build --platform linux/amd64,linux/arm64 -t ollama-ui .

echo "Build completed. You can now run with:"
echo "docker run -p 3000:3000 -p 11434:11434 ollama-ui"
