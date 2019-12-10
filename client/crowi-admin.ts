$(function() {
  $('#slackNotificationForm').on('submit', function(e) {
    $.post('/_api/admin/notification.add', $(this).serialize(), function(res) {
      if (res.ok) {
        // TODO Fix
        location.reload()
      }
    })

    return false
  })

  $('form.admin-remove-updatepost').on('submit', function(e) {
    $.post('/_api/admin/notification.remove', $(this).serialize(), function(res) {
      if (res.ok) {
        // TODO Fix
        location.reload()
      }
    })
    return false
  })

  $('#createdUserModal').modal('show')

  $('#admin-password-reset-modal').on('show.bs.modal', function(button) {
    const data = $((button as any).relatedTarget)
    const userId = data.data('user-id')
    const email = data.data('user-email')

    $('#admin-password-reset-user').text(email)
    $('#admin-users-reset-password input[name=user_id]').val(userId)
  })

  $('form#admin-users-reset-password').on('submit', function(e) {
    $.post('/_api/admin/users.resetPassword', $(this).serialize(), function(res) {
      if (res.ok) {
        // TODO Fix
        // location.reload();
        $('#admin-password-reset-modal').modal('hide')
        $('#admin-password-reset-modal-done').modal('show')

        $('#admin-password-reset-done-user').text(res.user.email)
        $('#admin-password-reset-done-password').text(res.newPassword)
        return
      }

      // fixme
      alert('Failed to reset password')
    })

    return false
  })

  const closePanel = () => {
    const $tr = $('#admin-users-table #target')
    if ($tr.length) {
      const $email = $tr.find('.email')
      const $emailInput = $email.find('input')
      const initial = $emailInput ? $emailInput.attr('initial') || '' : ''
      const $editPanel = $('#admin-users-table #edit-panel')
      const $padding = $('#admin-users-table .padding')
      $editPanel.on('animationend', () => {
        $tr.attr('id', '')
        $email.empty().text(initial)

        $editPanel.remove()
        $padding.remove()
      })
      $editPanel.addClass('contract')
    }
  }

  const openPanel = $tr => {
    const $email = $tr.find('.email')
    const $emailInput = $('<input>', { type: 'text', class: 'form-control', value: $email.text(), initial: $email.text() })

    const $editPanel = {
      container: $('<tr>', { id: 'edit-panel' }),
      td: $('<td>', { colspan: 7 }),
      div: $('<div>'),
      update: $('<button>', { type: 'submit', class: 'update btn btn-primary btn-sm' }).text('Update'),
      cancel: $('<button>', { type: 'button', class: 'cancel btn btn-default btn-sm' }).text('Cancel'),
    }
    const $padding = $('<tr>', { class: 'padding' })

    $tr.attr('id', 'target')
    $email.empty().append($emailInput)
    $editPanel.div.append([$editPanel.cancel, $editPanel.update])
    $editPanel.container.append($editPanel.td.append($editPanel.div))
    $tr.after($editPanel.container)
    $tr.after($padding)

    $editPanel.cancel.on('click', () => closePanel())
    $editPanel.update.on('click', async () => {
      const id = $tr.data('user-id')
      const email = $emailInput.val()
      const csrf = window.APP_CONTEXT.csrfToken
      const body = { user_id: id, email, _csrf: csrf }

      const { ok } = await window.crowi.apiPost('/admin/users.updateEmail', body)
      if (ok) {
        // TODO Fix
        location.reload()
      }
    })
  }

  $('#admin-users-table .edit-button').on('click', function() {
    const $tr = $(this).closest('tr')
    if ($tr.attr('id') === 'target') {
      return
    }

    closePanel()
    openPanel($tr)
  })

  $('#appSettingForm, #secSettingForm, #authSettingForm, #mailSettingForm, #awsSettingForm, #googleSettingForm, #githubSettingForm').each(function() {
    $(this).submit(function() {
      function showMessage(formId, msg, status = '') {
        $('#' + formId + ' .alert').remove()

        if (!status) {
          status = 'success'
        }
        const $message = $('<p class="alert"></p>')
        $message.addClass('alert-' + status)
        $message.html(msg.replace('\n', '<br>'))
        $message.insertAfter('#' + formId + ' legend')

        if (status == 'success') {
          setTimeout(function() {
            $message.fadeOut({
              complete: function() {
                $message.remove()
              },
            })
          }, 5000)
        }
      }

      const $form = $(this)
      const $id = $form.attr('id')
      const $button = $('button', this)
      $button.attr('disabled', 'disabled')
      const action = $form.attr('action')
      if (!action) return false
      $.post(action, $form.serialize(), function(data) {
        if (data.ok) {
          showMessage($id, 'Updated')
        } else {
          showMessage($id, data.error, 'danger')
        }
      })
        .fail(function() {
          showMessage($id, 'エラーが発生しました', 'danger')
        })
        .always(function() {
          $button.removeAttr('disabled')
        })
      return false
    })
  })
})
