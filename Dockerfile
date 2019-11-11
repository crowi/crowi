FROM node:10.17.0-buster-slim as builder

ENV CROWI_VERSION v1.8.0
ENV MONGOMS_DOWNLOAD_MIRROR https://downloads.mongodb.org

WORKDIR /crowi

COPY ./package.json ./package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

RUN rm -rf lib client

# Remove devDependencies if NODE_ENV is production
# TODO: verify that crowi can boot normally without devDependencies
#ARG NODE_ENV="production"
#ENV NODE_ENV ${NODE_ENV}
#RUN npm prune

FROM node:10.17.0-buster-slim

ARG NODE_ENV="production"

ENV CROWI_VERSION v1.8.0
ENV NODE_ENV ${NODE_ENV}

USER node

WORKDIR /crowi

COPY --from=builder --chown=node:node /crowi /crowi

CMD ["npm", "start"]
