module.exports = (crowi, app) => ({
  LoginChecker: require('./loginChecker')(crowi, app),
  CsrfVerify: require('./csrfVerify')(crowi, app),
  SwigFunctions: require('./swigFunctions')(crowi, app),
  SwigFilters: require('./swigFilters')(crowi, app),
  AdminRequired: require('./adminRequired')(crowi, app),
  LoginRequired: require('./loginRequired')(crowi, app),
  FileAccessRightOrLoginRequired: require('./fileAccessRightOrLoginRequired')(crowi, app),
  AccessTokenParser: require('./accessTokenParser')(crowi, app),
  ApplicationNotInstalled: require('./applicationNotInstalled')(crowi, app),
  ApplicationInstalled: require('./applicationInstalled')(crowi, app),
  AwsEnabled: require('./awsEnabled')(crowi, app),
  EncodeSpace: require('./encodeSpace')(crowi, app),
})
