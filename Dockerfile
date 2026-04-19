FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p data/uploads

EXPOSE 3030
CMD ["node", "server.js"]
