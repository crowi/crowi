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

    $ pnpm install

More info is [here](https://github.com/crowi/crowi/wiki/Install-and-Configuration).

### ⚠️WARNING⚠️

Don't use `master` branch because it is unstable. Use released version except when you want to contribute to the project.


Dependencies
-------------

* Node.js 22.x
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

### Quick Start

1. Start MongoDB and Redis services:
```bash
$ docker compose up -d
```

2. Copy the sample environment file and configure:
```bash
$ cp .env.sample .env
# Edit .env to set appropriate values
```

3. Install dependencies:
```bash
$ pnpm install
```

4. Run the development server:
```bash
$ pnpm dev
```

The application will be available at http://localhost:3000

### Docker Services

The docker compose file provides:
- **MongoDB 8**: Running on port 37017 (mapped from container's 27017)
- **Redis 7.4**: Running on port 16379 (mapped from container's 6379)

Data is persisted in `./data/mongodb/` directory.

### Troubleshooting

To manage Docker services:
```bash
# Stop services
$ docker compose stop

# Remove containers
$ docker compose down

# Remove containers and volumes
$ docker compose down -v

# View logs
$ docker compose logs -f
```

License
---------

* The MIT License (MIT)
* See LICENSE file.
