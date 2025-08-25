FROM node:20-alpine

# If you like bash for the entrypoint
RUN apk add --no-cache bash coreutils

# --- Bake the seed into the image ---
WORKDIR /opt/appseed

# Layer-friendly install: first lockfiles, then the rest
COPY package*.json ./
# For a dev server you likely need dev deps; drop --omit=dev if you use them
RUN npm ci

# Now add the app source (src, public, etc.)
COPY . .

# --- EntryPoint that seeds the volume by copying (no tar) ---
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Defaults; Machines will override WORKDIR to your mount path
ENV APPSEED=/opt/appseed \
    WORKDIR=/data

# Declare the mount location (optional but self-documenting)
VOLUME ["/data"]

# Runtime workdir is the mounted volume
WORKDIR /data

# Use our entrypoint; it will exec the CMD you provide
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Default command; can be overridden by Machines config if you want
CMD ["npm", "run", "dev-server"]
