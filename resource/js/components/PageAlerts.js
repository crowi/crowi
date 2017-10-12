import React from 'react';

import Icon from './Common/Icon';
import PageAlert from './PageAlerts/PageAlert';

export default class PageAlers extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      alertAppeared: false,
      message: '',
    };
  }

  componentDidMount() {
    const socket = this.props.crowi.getWebSocket();
    socket.on('page edited', (data) => {
      console.log('page edited', data);
      this.setState({
        alertAppeared: true,
        message: 'edit',
      });
      //if (data.user._id != me
      //  && data.page.path == pagePath) {
      //  $('#notifPageEdited').show();
      //  $('#notifPageEdited .edited-user').html(data.user.name);
      //}
    });
      /*
    const pageId = this.props.pageId;

    if (!pageId) {
      return ;
    }

    this.props.crowi.apiGet('/attachments.list', {page_id: pageId })
    .then(res => {
      const attachments = res.attachments;
      let inUse = {};

      for (const attachment of attachments) {
        inUse[attachment._id] = this.checkIfFileInUse(attachment);
      }

      this.setState({
        attachments: attachments,
        inUse: inUse,
      });
    });
    */
  }

  render() {
    //    const attachmentToDelete = this.state.attachmentToDelete;

    if (!this.state.alertAppeared) {
      return '';
    }

    //<span class="edited-user"></span> {{ t('edited this page') }} <a href="javascript:location.reload();"><i class="fa fa-angle-double-right"></i> {{ t('Load latest') }}</a>     </div>
    //return (
    //  <PageAlert {...props} className="fk-notif fk-notif-danger" alertType="warning">
    //    <Icon name="exclamation-triangle" />
    //    <PageAlert.Message>
    //    </PageAlert.Message>
    //  </PageAlert>
    //);
  }
}

