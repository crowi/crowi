import React from 'react';
import md5 from 'md5';
import PropTypes from 'prop-types';

// TODO UserComponent?
export default class UserPicture extends React.Component {

  getUserPicture(user) {
    // gravatar
    if (user.isGravatarEnabled === true) {
      return this.generateGravatarSrc(user);
    }
    // uploaded image
    else {
      return user.image || '/images/userpicture.png';
    }
  }

  generateGravatarSrc(user) {
    const email = user.email || '';
    const hash = md5(email.trim().toLowerCase());
    return `https://gravatar.com/avatar/${hash}`;
  }

  getClassName() {
    let className = ['picture', 'picture-rounded'];
    if (this.props.size) {
      className.push('picture-' + this.props.size);
    }

    return className.join(' ');
  }

  render() {
    const user = this.props.user;

    return (
      <img
        src={this.getUserPicture(user)}
        alt={user.username}
        className={this.getClassName()}
        />
    );
  }
}

UserPicture.propTypes = {
  user: PropTypes.object.isRequired,
  size: PropTypes.string,
};

UserPicture.defaultProps = {
  user: {},
  size: null,
};
