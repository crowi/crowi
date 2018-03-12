FROM node:6.13.1

ENV CROWI_VERSION v1.6.3
ENV NODE_ENV production

WORKDIR /crowi

ADD . /crowi
RUN npm install --unsafe-perm

CMD npm run start