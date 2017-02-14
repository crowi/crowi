import NotificationBaseModelAction from './NotificationBaseModelAction';

export default class NotificationPageComment extends NotificationBaseModelAction {
  render() {
    return (
      <li className="notification-list-li">
        <div className="notification-box">You had no notificatoins, yet.</div>
      </li>
    );
  }
}

NullNotification.propTypes = {
};

NullNotification.defaultProps = {
};

