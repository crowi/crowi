import React from 'react';

export default class AdminUserPageUserOperations extends React.Component {

  getEnabledActionsByUserStatus(user) {
    let statusAction;

    //<input type="hidden" name="_csrf" value="{{ csrf() }}">
    if (user.status === 1) { //
      statusAction = (
        <form action="/admin/user/{user._id}/activate" method="post">
          <button type="submit" className="btn btn-block btn-info">承認する</button>
        </form>
      );
    } else if (user.status === 2) {
      statusAction = (
        <form action="/admin/user/{user._id}/suspend" method="post">
          <button type="submit" className="btn btn-block btn-warning">アカウント停止</button>
        </form>
      );
    }

    /*
        {% if sUser.status == 3 %}
        <form action="/admin/user/{{ sUser._id.toString() }}/activate" method="post">
          <input type="hidden" name="_csrf" value="{{ csrf() }}">
          <button type="submit" className="btn btn-block btn-default">元に戻す</button>
        </form>
        </li>
        <li className="dropdown-button">
        {# label は同じだけど、こっちは論理削除 #}
        <form action="/admin/user/{{ sUser._id.toString() }}/remove" method="post">
          <input type="hidden" name="_csrf" value="{{ csrf() }}">
          <button type="submit" className="btn btn-block btn-danger">削除する</button>
        </form>
        {% endif  %}
        {% if sUser.status == 5 %}
        {# label は同じだけど、こっちは物理削除 #}
        <form action="/admin/user/{{ sUser._id.toString() }}/removeCompletely" method="post">
          <input type="hidden" name="_csrf" value="{{ csrf() }}">
          <button type="submit" className="btn btn-block btn-danger">削除する</button>
        </form>
        {% endif  %}
        </li>

        {% if sUser.status == 2 %} {# activated な人だけこのメニューを表示 #}
        <li className="divider"></li>
        <li className="dropdown-header">管理者メニュー</li>

        <li className="dropdown-button">
          {% if sUser.admin %}
            {% if sUser.username != user.username %}
            <form action="/admin/user/{{ sUser._id.toString() }}/removeFromAdmin" method="post">
              <input type="hidden" name="_csrf" value="{{ csrf() }}">
              <button type="submit" className="btn btn-block btn-danger">管理者からはずす</button>
            </form>
            {% else %}
            <p className="alert alert-danger">自分自身を管理者から外すことはできません</p>
            {% endif %}
          {% else %}
            <form action="/admin/user/{{ sUser._id.toString() }}/makeAdmin" method="post">
              <input type="hidden" name="_csrf" value="{{ csrf() }}">
              <button type="submit" className="btn btn-block btn-primary">管理者にする</button>
            </form>
          {% endif %}
        {% endif %}
        */

    return statusAction;
  }

  render() {
    const user = this.props.user;

    const enabledActions = this.getEnabledActionsByUserStatus(user);

    return (
      <div className="btn-group admin-user-menu">
        <button type="button" className="btn btn-default dropdown-toggle" data-toggle="dropdown">
          編集
          <span className="caret"></span>
        </button>
        <ul className="dropdown-menu" role="menu">
          <li className="divider"></li>
          <li className="dropdown-header">ステータス</li>
          <li className="dropdown-button">
          {enabledActions}
          </li>
        </ul>
      </div>
    );
  }
}


