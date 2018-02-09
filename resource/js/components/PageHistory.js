import React from 'react';
import PropTypes from 'prop-types';

import Icon from './Common/Icon';
import PageRevisionList from './PageHistory/PageRevisionList';

export default class PageHistory extends React.Component {

  constructor(props) {
    super(props);

    this.state = {
      revisions: [],
      diffOpened: {},
    };

    this.getPreviousRevision = this.getPreviousRevision.bind(this);
    this.onDiffOpenClicked = this.onDiffOpenClicked.bind(this);
  }

  componentDidMount() {
    const pageId = this.props.pageId;

    if (!pageId) {
      return ;
    }

    this.props.crowi.apiGet('/revisions.ids', {page_id: pageId})
    .then(res => {

      const rev = res.revisions;
      let diffOpened = {};
      const lastId = rev.length - 1;
      res.revisions.map((revision, i) => {
        const user = this.props.crowi.findUserById(revision.author);
        if (user) {
          rev[i].author = user;
        }

        if (i === 0 || i === lastId) {
          diffOpened[revision._id] = true;
        } else {
          diffOpened[revision._id] = false;
        }
      });

      this.setState({
        revisions: rev,
        diffOpened: diffOpened,
      });

      // load 0, and last default
      if (rev[0]) {
        this.fetchPageRevisionBody(rev[0]);
      }
      if (rev[1]) {
        this.fetchPageRevisionBody(rev[1]);
      }
      if (lastId !== 0 && lastId !== 1 && rev[lastId]) {
        this.fetchPageRevisionBody(rev[lastId]);
      }
    }).catch(err => {
      // do nothing
    });
  }

  getPreviousRevision(currentRevision) {
    let cursor = null;
    for (let revision of this.state.revisions) {
      if (cursor && cursor._id == currentRevision._id) {
        cursor = revision;
        break;
      }

      cursor = revision;
    }

    return cursor;
  }

  onDiffOpenClicked(revision) {
    const diffOpened = this.state.diffOpened,
      revisionId = revision._id;

    diffOpened[revisionId] = !(diffOpened[revisionId]);
    this.setState({
      diffOpened
    });

    this.fetchPageRevisionBody(revision);
    this.fetchPageRevisionBody(this.getPreviousRevision(revision));
  }

  fetchPageRevisionBody(revision) {
    if (revision.body) {
      return ;
    }

    this.props.crowi.apiGet('/revisions.get', {revision_id: revision._id})
    .then(res => {
      if (res.ok) {
        this.setState({
          revisions: this.state.revisions.map((rev) => {
            if (rev._id == res.revision._id) {
              return res.revision;
            }

            return rev;
          })
        })
      }
    }).catch(err => {

    });

  }

  render() {
    return (
      <div>
        <h1><Icon name="history" /> History</h1>
        <PageRevisionList
          revisions={this.state.revisions}
          diffOpened={this.state.diffOpened}
          getPreviousRevision={this.getPreviousRevision}
          onDiffOpenClicked={this.onDiffOpenClicked}
        />
      </div>
    );
  }
}

PageHistory.propTypes = {
  pageId: PropTypes.string,
  crowi: PropTypes.object.isRequired,
};
