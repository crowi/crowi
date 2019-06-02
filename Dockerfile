FROM node:8.12.0-alpine as builder

ARG NODE_ENV="production"

ENV CROWI_VERSION v1.8.0
ENV NODE_ENV ${NODE_ENV}

WORKDIR /crowi

ADD ./package.json ./package-lock.json ./
RUN SKIP_POSTINSTALL=true npm install --unsafe-perm

ADD . .

# Run postinstall manually
RUN npm run postinstall


FROM node:8.12.0-alpine

ARG NODE_ENV="production"

ENV CROWI_VERSION v1.8.0
ENV NODE_ENV ${NODE_ENV}

WORKDIR /crowi

COPY --from=builder /crowi /crowi

CMD npm run start
