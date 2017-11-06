import React from 'react';

import Icon from './Common/Icon';
import PageAlert from './PageAlerts/PageAlert';

export default class PageAlers extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      alertAppeared: false,
      message: '',
      data: {},
    };
  }

  componentDidMount() {
    const socket = this.props.crowi.getWebSocket();

    socket.on('page edited', (data) => {
      console.log('page edited', data);
      this.setState({
        alertAppeared: true,
        message: 'edit',
        data: data,
      });
      //if (data.user._id != me
      //  && data.page.path == pagePath) {
      //  $('#notifPageEdited').show();
      //  $('#notifPageEdited .edited-user').html(data.user.name);
      //}
    });
  }

  render() {
    //    const attachmentToDelete = this.state.attachmentToDelete;

    if (!this.state.alertAppeared) {
      return null;
    }

    return <PageAlert {...this.state} />;
  }
}

