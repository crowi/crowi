'use strict';

const ApiResponse = {} as any;

ApiResponse.error = function (err) {
  var result = {} as any;

  result = {
    ok: false
  };

  if (err instanceof Error) {
    result.error = err.toString();
  } else {
    result.error = err;
  }

  return result;
};

ApiResponse.success = function (data) {
  var result = data || {};

  result.ok = true;
  return result;
};

module.exports = ApiResponse;
