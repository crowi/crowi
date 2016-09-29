import React from 'react';
import Notification from './Notification';

export default class ListView extends React.Component {

  render() {
    const listView = this.props.pages.map((notification) => {
      return <Notification notification={notification} />;
    });

    return (
      <div className="notification-list">
        <ul className="notification-list-ul">
        {listView}
        </ul>
      </div>
    );
  }
}

ListView.propTypes = {
  notifications: React.PropTypes.array.isRequired,
};

ListView.defaultProps = {
  notifications: [],
};
