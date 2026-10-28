FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY data/facilities.sample.csv ./data/facilities.sample.csv
ENV MAMASAFE_ENV=production PORT=3000 MAMASAFE_DB=/app/data/mamasafe.db
VOLUME /app/data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
