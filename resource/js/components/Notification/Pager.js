import React from 'react';

export default class Pager extends React.Component {
  constructor(props) {
    super(props);
  }

  handleOnPrevClick(e) {
    e.preventDefault();
    this.props.handlePrevClick();
  }

  handleOnNextClick(e) {
    e.preventDefault();
    this.props.handleNextClick();
  }

  renderPrev() {
    if (this.props.hasPrev) {
      return (<a onClick={this.handleOnPrevClick.bind(this)}>Prev</a>);
    }

    return null;
  }

  renderNext() {
    if (this.props.hasNext) {
      return (<a onClick={this.handleOnNextClick.bind(this)}>Next</a>);
    }

    return null;
  }

  render() {
    const next = this.renderNext();
    const prev = this.renderPrev();

    return (
      <div className="notification-pager">
        <div className="pager pager-prev">{prev}</div>
        <div className="pager pager-next">{next}</div>
      </div>
    );
  };
};

Pager.propTypes = {
  hasPrev: React.PropTypes.bool.isRequired,
  hasNext: React.PropTypes.bool.isRequired,
  handlePrevClick: React.PropTypes.func.isRequired,
  handleNextClick: React.PropTypes.func.isRequired,
};
Pager.defaultProps = {
  hasPrev: false,
  hasNext: false,
};
