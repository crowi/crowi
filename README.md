<div align=center>
  <img src="https://raw.githubusercontent.com/crowi/crowi/master/public/logo/800x200.png" width="500" alt="Crowi">
</div>

<h1 align=center>Crowi</h1>
<p align=center>Empower the team with sharing your knowledge.</p>

<div align=center>
  <p align=center>
    <a href="https://heroku.com/deploy?template=https://github.com/crowi/crowi/tree/v1.7.9"><img src="https://www.herokucdn.com/deploy/button.png" alt="Delpoy"></a>
  </p>
  <p align=center>
    <img src="https://github.com/crowi/crowi/actions/workflows/main.yml/badge.svg" alt="GitHub Actions CI">
    <a href="https://codecov.io/gh/crowi/crowi"><img src="https://codecov.io/gh/crowi/crowi/branch/master/graph/badge.svg" alt="Codecov"></a>
    <a href="https://hub.docker.com/r/crowi/crowi"><img src="https://img.shields.io/docker/pulls/crowi/crowi.svg" alt="Docker Pulls"></a>
  </p>
</div>

Crowi is a **Markdown Wiki** like:

* Easy to edit and share,
* Markdown supported,
* Useful timeline list view,
* Fast.


Install
---------

Install dependencies and build CSS and JavaScript:

    $ npm install

More info is [here](https://github.com/crowi/crowi/wiki/Install-and-Configuration).

### ⚠️WARNING⚠️

Don't use `master` branch because it is unstable. Use released version except when you want to contribute to the project.


Dependencies
-------------

* Node.js 14.x
* MongoDB 4.2.x
* Elasticsearch 6.x.x or 7.x.x (optional) ([Doc is here](https://github.com/crowi/crowi/wiki/Configure-Search-Functions))
* Redis (optional)
* Amazon S3 (optional)
* Google Project (optional)
* Slack App (optional)


Start Up on Local
-------------------

Crowi is designed to be set up on Heroku or some PaaS, but you can also start up Crowi with ENV parameter on your local.

```
$ PASSWORD_SEED=somesecretstring MONGO_URI=mongodb://username:password@localhost/crowi node app.js
```
or please write `.env`.

### Environment


* `PORT`: Server port. default: `3000`.
* `BASE_URL`: Server base URL (e.g. https://demo.crowi.wiki/). If this env is not set, it is detected by accessing URL.
* `NODE_ENV`: `production` OR `development`.
* `MONGO_URI`: URI to connect to MongoDB. This parameter is also by `MONGOHQ_URL` OR `MONGOLAB_URI`.
* `REDIS_URL`: URI to connect to Redis (used for session store and socket.io). This parameter is also by `REDISTOGO_URL`.
    * Use `rediss://` scheme if you want to TLS connection to Redis.
    * `REDIS_REJECT_UNAUTHORIZED`: Set "0" if you want to skip the verification of certificate.
* `ELASTICSEARCH_URI`: URI to connect to Elasticearch.
* `PASSWORD_SEED`: A password seed used by password hash generator.
* `SECRET_TOKEN`: A secret key for verifying the integrity of signed cookies.
* `FILE_UPLOAD`: `aws` (default), `local`, `none`

Optional:

* `MATHJAX`: If set `1`, enable MathJax feature.
* `PLANTUML_URI`: If set the url of PlantUML server, then enable PlantUML feature. e.g. `http://localhost:18080`.
* `ENABLE_DNSCACHE`: If set `true`, Use internal DNS cache for crowi in Linux VMs. (See also: [#407](https://github.com/crowi/crowi/pull/407))

see: [.env.sample](./.env.sample)

For develop
-------------

We can use docker-compose for develop without complicated settings.

```
$ docker-compose -f docker-compose.development.yml up
```

- Express restarts when a file changed
- Webpack compiled assets automatically

### Troubleshooting

Please try the following commands.

```
# Stop containers
$ docker-compose -f docker-compose.development.yml stop
# Remove containers
$ docker-compose -f docker-compose.development.yml rm
# Remove images
$ docker-compose -f docker-compose.development.yml images -q | xargs docker rmi -f
# Build images
$ docker-compose -f docker-compose.development.yml build
```

License
---------

* The MIT License (MIT)
* See LICENSE file.
