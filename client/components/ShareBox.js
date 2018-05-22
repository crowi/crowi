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

export default class ShareBox extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
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
        if (share.filter(share => share.status === "active").length > 0) {
          this.updateState({ isCreated: true });
        }
      })
      .catch(err => {
        console.error(err);
      });
  }

  updateState(state) {
    const isChanging =
      state.isChanging === undefined ? this.state.isChanging : state.isChanging;
    const isCreated =
      state.isCreated === undefined ? this.state.isCreated : state.isCreated;
    this.setState({ isChanging, isCreated });
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
          {ActionButton(
            isCreated,
            isChanging,
            this.createLink,
            this.deleteLink
          )}
        </div>
        <div className="share-box-content">まだリンクは作成されていません</div>
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
