import React from 'react';

import moment from 'moment';

/**
 * UserDate
 *
 * display date depends on user timezone of user settings
 */
export default class UserDate extends React.Component {

  render() {
    const format = this.props.format;
    const dt = moment(this.props.dateTime);

    let dtFormat;
    if (format === 'fromNow') {
      dtFormat = dt.fromNow();
    } else {
      dtFormat = dt.format(format);
    }

    return (
      <span className={this.props.className}>
        {dtFormat}
      </span>
    );
  }
}

UserDate.propTypes = {
  dateTime: React.PropTypes.string.isRequired,
  format: React.PropTypes.string,
  className: React.PropTypes.string,
};

UserDate.defaultProps = {
  format: 'YYYY/MM/DD HH:mm:ss',
  className: '',
};

