//asyncのハンドラを扱ってくれるwrapper関数
//高階関数
//第1パラメーターには関数を受け取るようにして、関数を返すもの
module.exports = func => {
    return (req,res,next) => {
        //渡された関数で問題が起きたときにcatchしてエラーをnextに渡す
        func(req,res,next).catch(e => next(e));
    }
}