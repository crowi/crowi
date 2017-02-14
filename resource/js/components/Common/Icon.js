import React from 'react';

export default class Icon extends React.Component {

  render() {
    const name = this.props.name || null;
    const isSpin = this.props.spin ? ' fa-spinner' : '';

    if (!name) {
      return '';
    }

    return (
      <i className={`fa fa-${name} ${isSpin}`} />
    );
  }
}

// TODO: support size and so far
Icon.propTypes = {
  name: React.PropTypes.string.isRequired,
  spin: React.PropTypes.bool,
};

Icon.defaltProps = {
  spin: false,
};

