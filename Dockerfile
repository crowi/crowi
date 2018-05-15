FROM node:8.11.1

ARG NODE_ENV="production"

ENV CROWI_VERSION v1.6.3
ENV NODE_ENV ${NODE_ENV}

WORKDIR /crowi

ADD . /crowi
RUN npm install --unsafe-perm

CMD npm run start