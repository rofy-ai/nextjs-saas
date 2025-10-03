FROM node:20-alpine

# --- Bake the seed into the image ---
WORKDIR /app

# Layer-friendly install: first lockfiles, then the rest
COPY package*.json ./
# For a dev server you likely need dev deps; drop --omit=dev if you use them
RUN npm ci --legacy-peer-deps

# Now add the app source (src, public, etc.)
COPY . .

# Expose the Express server portt
EXPOSE 5001

# Default command; can be overridden by Machines config if you want
CMD ["npm", "run", "dev-server"]
