import React from "react";
import PropTypes from "prop-types";
import uuidv4 from "uuid/v4";
import Icon from "./Common/Icon";

function ActionButton(isCreated, isChanging, createAction, deleteAction) {
  const { button, icon, text, action } = isCreated
    ? {
        button: "btn-danger",
        icon: "unlink",
        text: "リンクを削除",
        action: deleteAction
      }
    : {
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

function Content(isCreated, share) {
  const baseUrl = "http://localhost:3000";
  const isActive = share => share.status === "active";
  const activeShare = share.filter(isActive).length > 0 ? share.filter(isActive)[0] : {};
  const shareId = activeShare.id;
  const url = `${baseUrl}/_share/${shareId}`;
  console.log(share);
  return isCreated ? (
    <div className="input-group">
      <span className="input-group-addon">共有用リンク</span>
      <input readOnly="" className="copy-link form-control" type="text" value={ url } />
    </div>
  ) : (
    "まだリンクは作成されていません"
  );
}

export default class ShareBox extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      share: [],
      isChanging: false,
      isCreated: props.isCreated
    };

    this.updateLink = this.updateLink.bind(this);
    this.createLink = this.createLink.bind(this);
    this.deleteLink = this.deleteLink.bind(this);
  }

  componentDidMount() {
    this.props.crowi
      .apiGet("/shares.list", { page_id: this.props.pageId })
      .then(({ share }) => {
        this.updateState({ share });
        if (share.filter(share => share.status === "active").length > 0) {
          this.updateState({ isCreated: true });
        }
      })
      .catch(err => {
        console.error(err);
      });
  }

  updateState(state) {
    const newState = Object.assign(this.state, state);
    this.setState(newState);
  }

  updateLink(promise) {
    const { isCreated } = this.state;
    this.updateState({ isChanging: true });
    promise
      .then(() => {
        console.log(isCreated, !isCreated)
        this.updateState({ isCreated: !isCreated });
      })
      .catch(err => {
        alert(err.message);
      })
      .finally(() => {
        this.updateState({ isChanging: false })
      })
  }

  createLink(e) {
    this.updateLink(this.props.crowi.apiPost("/shares.create", { id: uuidv4(), page_id: this.props.pageId }));
  }

  deleteLink(e) {
    this.updateLink(this.props.crowi.apiPost("/shares.delete", { page_id: this.props.pageId }));
  }

  render() {
    const { share, isCreated, isChanging } = this.state;
    return (
      <div className="share-box">
        <div className="share-box-header">
          <h5>外部に共有</h5>
          {ActionButton(
            isCreated,
            isChanging,
            this.createLink,
            this.deleteLink
          )}
        </div>
        <div className="share-box-content">
          {Content(
            isCreated,
            share
          )}
        </div>
      </div>
    );
  }
}

ShareBox.propTypes = {
  isCreated: PropTypes.bool,
  pageId: PropTypes.string,
  crowi: PropTypes.object.isRequired
};
ShareBox.defaultProps = {
  isCreated: false
};
