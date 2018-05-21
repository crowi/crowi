// This is the root component for #search-page

import React from 'react';
import PropTypes from 'prop-types';
import Icon from './Common/Icon';

function ActionButton(isCreated, isChanging, createAction, deleteAction) {
  const { button, icon, text, action } = isCreated ? {
    button: "btn-danger",
    icon: "unlink",
    text: "リンクを削除",
    action: deleteAction
  } : {
    button: "btn-primary",
    icon: "link",
    text: "リンクを作成",
    action: createAction
  };
  const iconName = isChanging ? "spinner" : icon;
  const buttonClass = ["btn", "btn-sm", button].join(" ");
  return (
    <button onClick={action} className={buttonClass} disabled={isChanging}>
      <Icon name={iconName} spin={isChanging} />
      {text}
    </button>
  );
}

export default class ShareBox extends React.Component {

  constructor(props) {
    super(props);

    this.state = {
      isChanging: false,
      isCreated: props.isCreated,
    };

    this.createLink = this.createLink.bind(this);
    this.deleteLink = this.deleteLink.bind(this);
  }

  updateLinkState(e) {
    this.setState({
      isChanging: true,
      isCreated: this.state.isCreated,
    });
  }

  createLink(e) {
    console.log(this.state);
    console.log("createLink clicked");
    this.updateLinkState();
    new Promise(resolve => setTimeout(resolve, 2000)).then(() => {
      console.log("created");
      this.setState({
        isChanging: false,
        isCreated: true,
      });
      console.log(this.state);
    });
    return false;
  }

  deleteLink(e) {
    console.log(this.state);
    console.log("deleteLink clicked");
    this.updateLinkState();
    new Promise(resolve => setTimeout(resolve, 2000)).then(() => {
      console.log("deleted");
      this.setState({
        isChanging: false,
        isCreated: false,
      });
      console.log(this.state);
    });
    return false;
  }

  // <button type="submit" class="btn btn-danger btn-sm">
  //   <i class="fa fa-unlink" aria-hidden="true"></i>
  //     リンクを削除
  //   </button>
  // </div>
  // <div class="share-box-content">
  //   <div class="input-group">
  //     <span class="input-group-addon">共有用リンク</span>
  //     <input readonly="" class="copy-link form-control" type="text" value="http://localhost:3000/5afa882da0238b00d24535d1" />
  //   </div>
  // </div>

  render() {
    const { isCreated, isChanging } = this.state;
    return (
      <div className="share-box">
        <div className="share-box-header">
          <h5>外部に共有</h5>
          {ActionButton(isCreated, isChanging, this.createLink, this.deleteLink)}
        </div>
        <div className="share-box-content">
          まだリンクは作成されていません
        </div>
      </div>
    );
  }
}

ShareBox.propTypes = {
  isCreated: PropTypes.bool,
};
ShareBox.defaultProps = {
  isCreated: false,
};

