var chai = require('chai')
  , expect = chai.expect
  , sinon = require('sinon')
  , sinonChai = require('sinon-chai')
  , utils = require('../utils.js')
  ;
chai.use(sinonChai);

describe('Url test', function () {
  var crowi = new (require(ROOT_DIR + '/lib/crowi'))(ROOT_DIR, process.env);
  //crowi.config.crowi['app:url'] = 'http://localhost:3000';

  //console.log(crowi.config);
  beforeEach(function() {
    crowi.config = {};
    crowi.config.crowi = {};
    crowi.config.crowi['app:url'] = 'http://localhost:3000';
  });


  it ('detectInternalLink', function() {
    var linkDetector = require(crowi.libDir + '/util/linkDetector')(crowi);

    var text = 'aaaaaaaa ';
    text += '[/user/suzuki/memo/2017/01/22/aaa](http://localhost:3000/58842b9ccf3556baedce2762)';
    text += ' bbbbb ';
    text += '[/user/suzuki/memo/2017/01/22/bbb](http://localhost:3000/58842b9ccf3556baedce2763)';
    text += 'ccccc';
    text += '</user/suzuki/memo/2017/01/22/ccc>';
    text += 'ddd';
    text += '[/user/suzuki/memo/2017/01/22/aaa](http://localhost:3000/58842b9ccf3556baedce2762)';
    text += ' bbbbb ';
    text += 'http://localhost:3000/user/suzuki/%E3%83%A1%E3%83%A2/2017/01/31/ddd#aaa';
    text += ' bbbbb ';
    text += 'http://localhost:3000/user/suzuki/メモ/2017/02/01/ddd?a=1';

    var results = linkDetector.search(text);

    expect(results).to.have.property('objectIds');
    expect(results.objectIds).to.have.length(2);
    expect(results.objectIds).to.contain('58842b9ccf3556baedce2762');
    expect(results.objectIds).to.contain('58842b9ccf3556baedce2763');

    expect(results).to.have.property('paths');
    expect(results.paths).to.have.length(3);
    expect(results.paths).to.contain('/user/suzuki/memo/2017/01/22/ccc');
    expect(results.paths).to.contain('/user/suzuki/メモ/2017/01/31/ddd');
    expect(results.paths).to.contain('/user/suzuki/メモ/2017/02/01/ddd');
  });
});
