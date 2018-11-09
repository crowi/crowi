FROM node:8.12.0

ARG NODE_ENV="production"

ENV CROWI_VERSION v1.8.0
ENV NODE_ENV ${NODE_ENV}
ENV SKIP_POSTINSTALL true

WORKDIR /crowi

ADD ./package.json ./package-lock.json ./
RUN npm install --unsafe-perm

ADD . .

# run postinstall manually
ENV SKIP_POSTINSTALL ""
RUN npm run postinstall

CMD npm run start
