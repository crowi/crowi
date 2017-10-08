'use strict';

var fs = require('fs');

var gulp   = require('gulp');
var sass   = require('gulp-sass');
var cssmin = require('gulp-cssmin');
var mocha  = require('gulp-spawn-mocha');
var concat = require('gulp-concat');
var rename = require('gulp-rename');
var jshint = require('gulp-jshint');
var source = require('vinyl-source-stream');
var webpack = require('webpack');
var webpackStream = require('webpack-stream');

var del     = require('del');
var stylish = require('jshint-stylish');

var pkg = require('./package.json');


var dirs = {
  cssSrc: './resource/css',
  cssDist: './public/css',
  jsSrc: './resource/js',
  jsDist: './public/js',
};

var css = {
  src: dirs.cssSrc + '/' + pkg.name + '.scss',
  main: dirs.cssDist + '/crowi-main.css',
  dist: dirs.cssDist + '/crowi.css',
  revealSrc: dirs.cssSrc + '/' + pkg.name + '-reveal.scss',
  revealDist: dirs.cssDist + '/crowi-reveal.css',
  watch: ['resource/css/*.scss'],
};

var js = {
  watch: ['test/**/*.test.js', 'app.js', 'lib/**/*.js'],
  lint: ['app.js', 'lib/**/*.js'],
  tests: tests.watch,
};

var cssIncludePaths = [
  'node_modules/bootstrap-sass/assets/stylesheets',
  'node_modules/font-awesome/scss',
  'node_modules/reveal.js/css'
];


gulp.task('css:sass', function() {
  gulp.src(css.revealSrc) // reveal
    .pipe(sass({
        outputStyle: 'nesed',
        sourceComments: 'map',
        includePaths: cssIncludePaths
    }).on('error', sass.logError))
    .pipe(gulp.dest(dirs.cssDist));

  return gulp.src(css.src)
    .pipe(sass({
        outputStyle: 'nesed',
        sourceComments: 'map',
        includePaths: cssIncludePaths
    }).on('error', sass.logError))
    .pipe(rename({suffix: '-main'})) // create -main.css to prepare concating with highlight.js's css
    .pipe(gulp.dest(dirs.cssDist));
});

gulp.task('css:concat', ['css:sass'], function() {
  return gulp.src([
      css.main,
      'node_modules/highlight.js/styles/tomorrow-night.css',
      'node_modules/diff2html/dist/diff2html.css',
    ])
    .pipe(concat('crowi.css'))
    .pipe(gulp.dest(dirs.cssDist))
});

gulp.task('css:min', ['css:concat'], function() {
  gulp.src(css.revealDist)
    .pipe(cssmin())
    .pipe(rename({suffix: '.min'}))
    .pipe(gulp.dest(dirs.cssDist));

  return gulp.src(css.dist)
    .pipe(cssmin())
    .pipe(rename({suffix: '.min'}))
    .pipe(gulp.dest(dirs.cssDist));
});

gulp.task('watch', function() {
  var watchLogger = function(event) {
    console.log('File ' + event.path + ' was ' + event.type + ', running tasks...');
  };

  var cssWatcher = gulp.watch(css.watch, ['css:concat']);
  cssWatcher.on('change', watchLogger);
  var jsWatcher = gulp.watch(js.clientWatch, ['webpack']);
  jsWatcher.on('change', watchLogger);
});

gulp.task('css', ['css:sass', 'css:concat',]);
gulp.task('default', ['css:min', 'webpack', ]);
gulp.task('dev', ['css:concat', 'webpack', 'jshint', 'test']);
