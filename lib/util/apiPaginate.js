'use strict';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 1000;

const OFFSET_DEFAULT = 0;

const parseIntValue = function (value, defaultValue, maxLimit) {
  if (!value) {
    return defaultValue;
  }

  var v = parseInt(value);
  if (!maxLimit) {
    return v;
  }

  return ((v <= 10) ? v : maxLimit);
};

function ApiPaginate () {
};

ApiPaginate.parseOptions = function(params) {
  var limit = parseIntValue(params.limit, LIMIT_DEFAULT, LIMIT_MAX);
  var offset = parseIntValue(params.offset, OFFSET_DEFAULT);
  console.log('limit', limit);
  console.log('offset', offset);

  return {limit: limit, offset: offset};
};

module.exports = ApiPaginate;
