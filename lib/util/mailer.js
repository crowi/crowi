/**
 * mailer
 */

module.exports = function(crowi) {
  'use strict';

  var debug = require('debug')('crowi:lib:mailer')
    , nodemailer = require('nodemailer')
    , swig = require('swig')
    , config = crowi.getConfig()
    , mailConfig = {}
    , mailer = undefined
    , MAIL_TEMPLATE_DIR = crowi.mailDir

    // FIXME: this is same as local_modules/crowi-fileupload-aws
    , getAwsConfig = function() {
        var config = crowi.getConfig();
        return {
          accessKeyId: config.crowi['aws:accessKeyId'],
          secretAccessKey: config.crowi['aws:secretAccessKey'],
          region: config.crowi['aws:region'],
          bucket: config.crowi['aws:bucket']
        };
      };
    ;


  function createSMTPClient(option)
  {
    var client;

    debug('createSMTPClient option', option);
    if (!option) {
      option = {
        host: config.crowi['mail:smtpHost'],
        port: config.crowi['mail:smtpPort'],
      };

      if (config.crowi['mail:smtpUser'] && config.crowi['mail:smtpPassword']) {
        option.auth =  {
          user: config.crowi['mail:smtpUser'],
          pass: config.crowi['mail:smtpPassword']
        };
      }
      if (option.port === 465) {
        option.secure = true;
      }
    }
    option.tls = {rejectUnauthorized: false};

    client = nodemailer.createTransport(option);

    debug('mailer set up for SMTP', client);
    return client;
  }

  function createSESClient(option) {
    const aws = require('aws-sdk');
    const awsConfig = getAwsConfig();

    // FIXME: update しまくりでエエンカイ
    aws.config.update({
      accessKeyId: awsConfig.accessKeyId,
      secretAccessKey: awsConfig.secretAccessKey,
      region: awsConfig.region
    });

    // create Nodemailer SES transporter
    const client = nodemailer.createTransport({
      SES: new aws.SES({
        apiVersion: '2010-12-01'
      })
    });

    debug('mailer set up for SES', client);
    return client;
  }

  function initialize() {
    if (!config.crowi['mail:from']) {
      return;
    }

    if (config.crowi['mail:smtpHost'] && config.crowi['mail:smtpPort']
    ) {
      // SMTP 設定がある場合はそれを優先
      mailer = createSMTPClient();

    } else if (config.crowi['aws:accessKeyId'] && config.crowi['aws:secretAccessKey']) {
      // AWS 設定がある場合はSESを設定
      mailer = createSESClient();
    } else {
      mailer = undefined;
    }

    mailConfig.from = config.crowi['mail:from'];
    mailConfig.subject = 'Mail from ' + config.crowi['app:title'];

    debug('mailer initialized');
  }

  function setupMailConfig (overrideConfig) {
    var c = overrideConfig
      , mc = {}
    ;
    mc = mailConfig;

    mc.to      = c.to;
    mc.from    = c.from || mailConfig.from;
    mc.text    = c.text;
    mc.subject = c.subject || mailConfig.subject;

    return mc;
  }

  function send(config, callback) {
    if (mailer) {
      var templateVars = config.vars || {};
      return swig.renderFile(
        MAIL_TEMPLATE_DIR + config.template,
        templateVars,
        function (err, output) {
          if (err) {
            throw err;
          }

          config.text = output;
          return mailer.sendMail(setupMailConfig(config), callback);
        }
      );
    } else {
      debug('Mailer is not completed to set up. Please set up SMTP or AWS setting.');
      return callback(new Error('Mailer is not completed to set up. Please set up SMTP or AWS setting.'), null);
    }
  }


  initialize();

  return {
    createSMTPClient: createSMTPClient,
    createSESClient: createSESClient,
    mailer: mailer,
    send: send,
  };
};
