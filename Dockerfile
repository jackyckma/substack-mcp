FROM node:24.19.0-alpine

LABEL io.modelcontextprotocol.server.name="io.github.marcomoauro/substack-mcp"

COPY ./ /opt
WORKDIR /opt

RUN npm ci --omit=dev && \
    npm cache clean --force;

# This image defaults to the Streamable HTTP transport for remote deployment (e.g. Zeabur).
# Set TRANSPORT=stdio to run it as a local subprocess MCP server instead (e.g. `docker run -i`).
ENV TRANSPORT=http
EXPOSE 3000

CMD ["node", "src/index.js"]
