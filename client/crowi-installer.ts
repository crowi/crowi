import { alert } from 'components/Common/Icons'
import renderIcon from 'common/functions/renderIcon'

$(function() {
  $('#register-form input[name="registerForm[username]"]').change(function(e) {
    const username = $(this).val()
    $('#input-group-username').removeClass('has-error')
    $('#help-block-username').html('')

    $.getJSON('/_api/check_username', { username: username }, function(json) {
      if (!json.valid) {
        $('#help-block-username').html(`${renderIcon(alert)}このユーザーIDは利用できません。<br>`)
        $('#input-group-username').addClass('has-error')
      }
    })
  })
})
