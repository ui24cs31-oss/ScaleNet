const axios = require('axios');
axios.post('http://localhost:3000/task', {type: 'interactive', complexity: 2})
  .then(res => console.log('OK', res.data))
  .catch(err => {
    console.log('Error hitting load-balancer:');
    console.log(JSON.stringify(err.response?.data, null, 2));
  });
