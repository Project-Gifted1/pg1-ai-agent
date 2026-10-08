// Popular package names for check_package's look-alike detector (1.17.0).
//
// A hand-kept list of widely installed npm and PyPI package names, the
// names attackers most often imitate (typosquats, and the plausible names an
// AI assistant invents and attackers then register). Package names are
// facts, not copyrighted content: nothing here was copied from a download
// ranking or any third-party dataset. The list only has to contain names
// worth imitating; it does not have to be complete or in any order of
// popularity.
//
// Rules for entries: exactly as the registry spells the canonical name, in
// lowercase. PyPI names are PEP 503 normalised (lowercase, runs of "-", "_"
// and "." collapsed to "-"), since that is how check_package compares them.
// A name in this list is never reported as a look-alike of another entry.

// When this list was last reviewed: the data_as_of of check_package's
// "popular package names" check.
export const POPULAR_PACKAGES_AS_OF = '2026-10-08T00:00:00.000Z';

export const POPULAR_NPM_PACKAGES = Object.freeze([
  'lodash', 'react', 'react-dom', 'chalk', 'express', 'axios', 'commander', 'debug', 'tslib', 'moment',
  'request', 'uuid', 'fs-extra', 'async', 'bluebird', 'underscore', 'prop-types', 'vue', 'typescript', 'webpack',
  'classnames', 'yargs', 'glob', 'minimist', 'semver', 'mkdirp', 'rimraf', 'colors', 'dotenv', 'body-parser',
  'jquery', 'core-js', 'rxjs', 'inquirer', 'zod', 'next', 'eslint', 'prettier', 'jest', 'mocha',
  'chai', 'sinon', 'ws', 'socket.io', 'socket.io-client', 'cors', 'jsonwebtoken', 'bcrypt', 'bcryptjs', 'mongoose',
  'mongodb', 'mysql', 'mysql2', 'pg', 'redis', 'ioredis', 'sequelize', 'knex', 'prisma', '@prisma/client',
  'graphql', 'apollo-server', '@apollo/client', 'node-fetch', 'cross-fetch', 'isomorphic-fetch', 'got', 'superagent', 'qs', 'cookie-parser',
  'morgan', 'helmet', 'multer', 'nodemailer', 'passport', 'passport-jwt', 'passport-local', 'express-session', 'compression', 'http-proxy-middleware',
  'cheerio', 'puppeteer', 'playwright', 'selenium-webdriver', 'jsdom', 'xml2js', 'yaml', 'js-yaml', 'ini', 'toml',
  'date-fns', 'dayjs', 'luxon', 'moment-timezone', 'numeral', 'validator', 'joi', 'yup', 'ajv', 'class-validator',
  'class-transformer', 'reflect-metadata', 'inversify', 'rxjs-compat', 'immer', 'immutable', 'redux', 'react-redux', '@reduxjs/toolkit', 'redux-thunk',
  'redux-saga', 'mobx', 'mobx-react', 'zustand', 'jotai', 'recoil', 'react-router', 'react-router-dom', 'react-query', '@tanstack/react-query',
  'swr', 'formik', 'react-hook-form', 'styled-components', '@emotion/react', '@emotion/styled', 'tailwindcss', 'postcss', 'autoprefixer', 'sass',
  'less', 'stylus', 'css-loader', 'style-loader', 'sass-loader', 'file-loader', 'url-loader', 'babel-loader', 'ts-loader', 'html-webpack-plugin',
  'mini-css-extract-plugin', 'terser-webpack-plugin', 'webpack-cli', 'webpack-dev-server', 'webpack-merge', 'vite', 'rollup', 'esbuild', 'parcel', 'gulp',
  'grunt', 'browserify', 'babel-core', '@babel/core', '@babel/preset-env', '@babel/preset-react', '@babel/runtime', '@babel/polyfill', 'babel-eslint', 'babel-polyfill',
  'nodemon', 'pm2', 'forever', 'concurrently', 'cross-env', 'npm-run-all', 'husky', 'lint-staged', 'ts-node', 'tsx',
  'ts-jest', '@types/node', '@types/react', '@types/react-dom', '@types/express', '@types/jest', '@types/lodash', 'eslint-plugin-react', 'eslint-config-airbnb', 'eslint-plugin-import',
  '@typescript-eslint/parser', '@typescript-eslint/eslint-plugin', 'eslint-config-prettier', 'eslint-plugin-prettier', 'stylelint', 'karma', 'jasmine', 'vitest', 'cypress', 'supertest',
  'nock', 'faker', '@faker-js/faker', 'chance', 'nanoid', 'shortid', 'crypto-js', 'bn.js', 'big.js', 'decimal.js',
  'bignumber.js', 'ethers', 'web3', 'viem', 'wagmi', '@solana/web3.js', 'bitcoinjs-lib', 'tweetnacl', 'elliptic', 'secp256k1',
  'buffer', 'events', 'process', 'util', 'path-browserify', 'stream-browserify', 'readable-stream', 'through2', 'concat-stream', 'pump',
  'once', 'inherits', 'safe-buffer', 'string_decoder', 'graceful-fs', 'chokidar', 'micromatch', 'minimatch', 'fast-glob', 'globby',
  'del', 'ora', 'cli-progress', 'progress', 'boxen', 'figlet', 'kleur', 'picocolors', 'ansi-styles', 'supports-color',
  'strip-ansi', 'wrap-ansi', 'string-width', 'escape-string-regexp', 'ms', 'mime', 'mime-types', 'iconv-lite', 'he', 'entities',
  'marked', 'markdown-it', 'highlight.js', 'prismjs', 'handlebars', 'ejs', 'pug', 'mustache', 'nunjucks', 'jade',
  'koa', 'koa-router', 'hapi', '@hapi/hapi', 'fastify', 'restify', 'sails', '@nestjs/core', '@nestjs/common',
  'angular', '@angular/core', '@angular/common', 'svelte', 'preact', 'solid-js', 'ember-source', 'backbone', 'three', 'd3',
  'chart.js', 'echarts', 'leaflet', 'mapbox-gl', 'gsap', 'animejs', 'framer-motion', 'react-spring', 'lottie-web', 'swiper',
  'electron', 'react-native', 'expo', 'ionic', '@capacitor/core', 'cordova', 'aws-sdk', '@aws-sdk/client-s3', 'firebase', 'firebase-admin',
  'stripe', 'twilio', 'openai', '@anthropic-ai/sdk', 'langchain', 'discord.js', 'telegraf', 'node-telegram-bot-api', 'slack', '@slack/web-api',
  'winston', 'pino', 'bunyan', 'log4js', 'loglevel', 'sharp', 'jimp', 'canvas', 'pdfkit', 'pdf-lib',
  'xlsx', 'exceljs', 'csv-parse', 'csv-parser', 'papaparse', 'archiver', 'adm-zip', 'jszip', 'tar', 'unzipper',
  'form-data', 'busboy', 'formidable', 'node-cron', 'cron', 'agenda', 'bull', 'bullmq', 'amqplib', 'kafkajs',
  'node-gyp', 'node-sass', 'bindings', 'nan', 'node-addon-api', 'prebuild-install', 'esm', 'source-map', 'source-map-support', 'regenerator-runtime',
  'whatwg-fetch', 'abort-controller', 'node-abort-controller', 'eventemitter3', 'p-limit', 'p-queue', 'p-retry', 'retry', 'deepmerge', 'lodash.merge',
  'object-assign', 'clone', 'clone-deep', 'fast-deep-equal', 'deep-equal', 'json5', 'jsonfile', 'fast-json-stringify', 'flatted', 'serialize-javascript',
  'event-stream', 'left-pad', 'is-number', 'is-odd', 'is-even', 'kind-of', 'isarray', 'has', 'shelljs', 'execa',
  'cross-spawn', 'which', 'open', 'opn', 'portfinder', 'get-port', 'detect-port', 'http-server', 'serve', 'live-server',
  'browser-sync', 'sockjs', 'axios-retry', 'ky', 'undici', 'node-cache', 'lru-cache', 'quick-lru', 'keyv', 'cache-manager',
  'ua-parser-js', 'coa', 'rc', 'color', 'color-string', 'colorette', 'yocto-queue', 'eslint-scope', 'electron-builder', 'electron-updater'
]);

export const POPULAR_PYPI_PACKAGES = Object.freeze([
  'requests', 'urllib3', 'certifi', 'charset-normalizer', 'idna', 'setuptools', 'pip', 'wheel', 'six', 'python-dateutil',
  'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'scikit-learn', 'sklearn', 'tensorflow', 'keras', 'torch',
  'torchvision', 'torchaudio', 'transformers', 'tokenizers', 'datasets', 'huggingface-hub', 'accelerate', 'diffusers', 'sentencepiece', 'safetensors',
  'openai', 'anthropic', 'langchain', 'langchain-core', 'langchain-community', 'llama-index', 'tiktoken', 'pydantic', 'pydantic-core', 'fastapi',
  'flask', 'django', 'starlette', 'uvicorn', 'gunicorn', 'werkzeug', 'jinja2', 'markupsafe', 'itsdangerous', 'click',
  'boto3', 'botocore', 's3transfer', 'awscli', 'google-api-python-client', 'google-auth', 'google-cloud-storage', 'azure-core', 'azure-storage-blob', 'aiohttp',
  'httpx', 'httpcore', 'h11', 'anyio', 'sniffio', 'websockets', 'websocket-client', 'pyyaml', 'toml', 'tomli',
  'attrs', 'packaging', 'pyparsing', 'typing-extensions', 'importlib-metadata', 'zipp', 'filelock', 'platformdirs', 'virtualenv', 'distlib',
  'cryptography', 'cffi', 'pycparser', 'pyopenssl', 'bcrypt', 'paramiko', 'pynacl', 'pycryptodome', 'pycrypto', 'pyjwt',
  'jsonschema', 'simplejson', 'ujson', 'orjson', 'msgpack', 'protobuf', 'grpcio', 'grpcio-tools', 'thrift', 'avro',
  'sqlalchemy', 'alembic', 'psycopg2', 'psycopg2-binary', 'psycopg', 'pymysql', 'mysqlclient', 'mysql-connector-python', 'pymongo', 'redis',
  'celery', 'kombu', 'billiard', 'rq', 'dramatiq', 'apscheduler', 'schedule', 'pika', 'kafka-python', 'confluent-kafka',
  'pytest', 'pytest-cov', 'pytest-mock', 'pytest-asyncio', 'pytest-xdist', 'coverage', 'mock', 'nose', 'tox', 'hypothesis',
  'black', 'flake8', 'pylint', 'mypy', 'isort', 'autopep8', 'yapf', 'ruff', 'bandit', 'pre-commit',
  'beautifulsoup4', 'bs4', 'lxml', 'html5lib', 'scrapy', 'selenium', 'playwright', 'mechanize', 'requests-html', 'parsel',
  'pillow', 'opencv-python', 'opencv-python-headless', 'imageio', 'scikit-image', 'pytesseract', 'wand', 'pyautogui', 'pygame', 'kivy',
  'tqdm', 'rich', 'colorama', 'termcolor', 'tabulate', 'prettytable', 'click-plugins', 'typer', 'fire', 'docopt',
  'python-dotenv', 'dotenv', 'environs', 'configparser', 'pyinstaller', 'cx-freeze', 'py2exe', 'nuitka', 'cython', 'numba',
  'sympy', 'networkx', 'statsmodels', 'xgboost', 'lightgbm', 'catboost', 'plotly', 'bokeh', 'dash', 'streamlit',
  'gradio', 'jupyter', 'jupyterlab', 'notebook', 'ipython', 'ipykernel', 'ipywidgets', 'nbformat', 'nbconvert', 'jupyter-client',
  'pytz', 'tzdata', 'tzlocal', 'arrow', 'pendulum', 'babel', 'dateparser', 'python-slugify', 'unidecode', 'chardet',
  'docutils', 'sphinx', 'mkdocs', 'mkdocs-material', 'markdown', 'mistune', 'pygments', 'jedi', 'parso', 'prompt-toolkit',
  'psutil', 'pywin32', 'pexpect', 'ptyprocess', 'sh', 'plumbum', 'fabric', 'invoke', 'ansible', 'ansible-core',
  'docker', 'kubernetes', 'openshift', 'fabric2', 'salt', 'pulumi', 'boto', 'moto', 'localstack', 'troposphere',
  'twisted', 'tornado', 'gevent', 'greenlet', 'eventlet', 'trio', 'uvloop', 'aiofiles', 'asyncpg', 'aiomysql',
  'web3', 'eth-account', 'eth-abi', 'eth-utils', 'py-evm', 'solana', 'bitcoinlib', 'ccxt', 'python-binance', 'ecdsa',
  'discord-py', 'python-telegram-bot', 'slack-sdk', 'tweepy', 'praw', 'twilio', 'stripe', 'sendgrid', 'yagmail',
  'xlrd', 'xlwt', 'openpyxl', 'xlsxwriter', 'python-docx', 'python-pptx', 'pypdf', 'pypdf2', 'pdfminer-six', 'reportlab',
  'nltk', 'spacy', 'gensim', 'textblob', 'langdetect', 'fuzzywuzzy', 'rapidfuzz', 'python-levenshtein', 'jellyfish', 'regex',
  'more-itertools', 'toolz', 'cachetools', 'decorator', 'wrapt', 'deprecated', 'retrying', 'tenacity', 'backoff', 'ratelimit',
  'sentry-sdk', 'loguru', 'structlog', 'prometheus-client', 'opentelemetry-api', 'opentelemetry-sdk', 'newrelic', 'ddtrace', 'elasticsearch', 'opensearch-py',
  'marshmallow', 'cerberus', 'voluptuous', 'schema', 'pyrsistent', 'dataclasses-json', 'cattrs', 'msgspec', 'dacite', 'jsonpickle',
  'graphene', 'strawberry-graphql', 'ariadne', 'djangorestframework', 'django-cors-headers', 'django-filter', 'django-environ', 'flask-cors', 'flask-sqlalchemy', 'flask-login',
  'wtforms', 'flask-wtf', 'gql', 'zeep', 'suds', 'xmltodict', 'defusedxml', 'pyasn1', 'rsa', 'oauthlib',
  'requests-oauthlib', 'authlib', 'python-jose', 'passlib', 'argon2-cffi', 'keyring', 'secretstorage', 'jeepney', 'pywin32-ctypes', 'colorlog'
]);
