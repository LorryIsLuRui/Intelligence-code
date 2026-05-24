/**
 * 展示一个可关闭横幅
 * @param {Object} props - 横幅属性
 * @returns {Object} banner view
 */
export const JsBanner = ({ title, onClose }) => {
    localStorage.setItem('banner-title', title);
    return <button onClick={onClose}>{title}</button>;
};
