import React from 'react';
import PropTypes from 'prop-types';

export default class Icon extends React.Component {

  render() {
    const name = this.props.name || null;
    const isSpin = this.props.spin ? ' fa-spinner' : '';
    const { solid: s, regular: r, light: l } = this.props;
    const type = s ? 's' : r ? 'r' : l ? 'l' :'';

    if (!name) {
      return '';
    }

    return (
      <i className={`fa${type} fa-${name} ${isSpin}`} />
    );
  }
}

// TODO: support size and so far
Icon.propTypes = {
  name: PropTypes.string.isRequired,
  solid: PropTypes.bool,
  regular: PropTypes.bool,
  light: PropTypes.bool,
  spin: PropTypes.bool,
};

Icon.defaltProps = {
  spin: false,
  solid: false,
  regular: false,
  light: false
};

