import $ from 'jquery'

$(function() {
  var UpdatePost = {}

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
    var data = $(button.relatedTarget)
    var userId = data.data('user-id')
    var email = data.data('user-email')

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

  $('#appSettingForm, #secSettingForm, #mailSettingForm, #awsSettingForm, #googleSettingForm, #githubSettingForm').each(
    function() {
      $(this).submit(function() {
        function showMessage(formId, msg, status) {
          $('#' + formId + ' .alert').remove()

          if (!status) {
            status = 'success'
          }
          var $message = $('<p class="alert"></p>')
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

        var $form = $(this)
        var $id = $form.attr('id')
        var $button = $('button', this)
        $button.attr('disabled', 'disabled')
        var jqxhr = $.post($form.attr('action'), $form.serialize(), function(data) {
          if (data.status) {
            showMessage($id, '更新しました')
          } else {
            showMessage($id, data.message, 'danger')
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
    },
  )
})
