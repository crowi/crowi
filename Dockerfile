FROM node:10.16.0-alpine as builder

ARG NODE_ENV="production"

ENV CROWI_VERSION v1.8.0
ENV NODE_ENV ${NODE_ENV}

WORKDIR /crowi

ADD ./package.json ./package-lock.json ./
RUN SKIP_POSTINSTALL=true npm install

ADD . .

# Run postinstall manually
RUN npm run postinstall


FROM node:10.16.0-alpine

ARG NODE_ENV="production"

ENV CROWI_VERSION v1.8.0
ENV NODE_ENV ${NODE_ENV}

USER node

WORKDIR /crowi

COPY --from=builder --chown=node:node /crowi /crowi

CMD npm run start
